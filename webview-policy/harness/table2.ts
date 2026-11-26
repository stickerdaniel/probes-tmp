import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Json = Record<string, any>
type State = 'closed' | 'open' | 'not measured'
type Cell = { state: State; note: string }

const dir = process.argv[2] ?? 'results'
const systems = ['macos-15', 'windows-2025', 'ubuntu-24.04'].filter((s) => existsSync(join(dir, s)))
const engine: Record<string, string> = { 'macos-15': 'WKWebView', 'windows-2025': 'WebView2', 'ubuntu-24.04': 'WebKitGTK' }
const ROUTES = ['assign', 'replace', 'link', 'form-self', 'form-blank', 'form-top', 'form-parent', 'meta', 'open', 'download', 'nested', 'assign-dns', 'link-dns', 'nested-dns']

const load = (system: string, file: string): Json | null => {
  const p = join(dir, system, `${file}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

const titleReport = (r: Json, key: string): Json | null => r.report?.events?.[key]?.data?.report ?? null

type Route = { requests: number; bare: number; dns: number; wrapperOwn: boolean; framePong: boolean | null; denied: number }

const routeStats = (r: Json): Record<string, Route> => {
  const notes = r.report?.notes ?? {}
  const starts = ROUTES.map((route) => ({ route, at: r.startedAt + (notes[`route.${route}`]?.startedMs ?? 0) })).sort((a, b) => a.at - b.at)
  const routeAt = (t: number) => starts.filter((s) => s.at <= t).at(-1)?.route
  const out: Record<string, Route> = {}
  for (const route of ROUTES) {
    const rep = titleReport(r, `A.nav-${route}`)
    const after = String(notes[`route.${route}`]?.urlAfter ?? '')
    out[route] = { requests: 0, bare: 0, dns: 0, wrapperOwn: /wrap\.html\?r=/.test(after), framePong: rep ? Boolean(rep.pong) : null, denied: 0 }
  }
  for (const h of r.sink ?? []) {
    const m = /\/nav-([a-z-]+)/.exec(h.firstLine ?? '')
    const route = m ? m[1] : routeAt(h.t)
    if (!route || !out[route]) continue
    if (h.firstLine) out[route].requests++
    else out[route].bare++
  }
  for (const q of r.dns ?? []) {
    const route = ROUTES.find((x) => x.endsWith('-dns') && q.name.startsWith(`${x.slice(0, -4)}-`))
    if (route) out[route].dns++
  }
  for (const n of r.report?.navigations ?? []) {
    if (n.allow !== false) continue
    const m = /\/nav-([a-z-]+)/.exec(n.url ?? '')
    if (m && out[m[1]]) out[m[1]].denied++
  }
  return out
}

const egress = (x: Route) => x.requests + x.bare + x.dns > 0
const describe = (x: Route) =>
  `${x.requests} req, ${x.bare} TCP only${x.dns ? `, ${x.dns} DNS` : ''}; wrapper ${x.wrapperOwn ? 'own' : 'replaced'}; frame ${x.framePong === null ? 'no report' : x.framePong ? 'own' : 'replaced'}${x.denied ? `; on_navigation denied ${x.denied}` : ''}`

const skip = (r: Json | null) => (!r ? 'no result file' : r.notRun ?? r.notApplicable ?? (r.report ? null : `no report, exit ${r.exitCode}`))

const out: string[] = []
const navVariants = ['N2C', 'N2W', 'N2CC', 'N2CO', 'N2WO']
out.push('### Navigation per route')
out.push('')
out.push(`| Route | ${systems.flatMap((s) => navVariants.map((v) => `${engine[s]} ${v}`)).join(' | ')} |`)
out.push(`| --- | ${systems.flatMap(() => navVariants.map(() => '---')).join(' | ')} |`)
const stats: Record<string, Record<string, Record<string, Route> | null>> = {}
for (const s of systems) {
  stats[s] = {}
  for (const v of navVariants) {
    const r = load(s, v)
    stats[s][v] = skip(r) ? null : routeStats(r!)
  }
}
for (const route of ROUTES) {
  out.push(`| ${route} | ${systems.flatMap((s) => navVariants.map((v) => (stats[s][v] ? describe(stats[s][v]![route]) : 'no result'))).join(' | ')} |`)
}

const navCell = (s: string, v: string): Cell => {
  const st = stats[s][v]
  if (!st) return { state: 'not measured', note: 'no result' }
  const controls = ['N2CO', v.startsWith('N2W') ? 'N2WO' : 'N2CO'].map((c) => stats[s][c]).filter(Boolean) as Record<string, Route>[]
  const routes = ROUTES.filter((r) => !r.endsWith('-dns'))
  const openRoutes = routes.filter((r) => egress(st[r]))
  const measurable = routes.filter((r) => controls.some((c) => egress(c[r]) || !c[r].wrapperOwn || c[r].framePong === false))
  const replacedFrame = routes.filter((r) => st[r].framePong === false)
  const replacedWrapper = routes.filter((r) => !st[r].wrapperOwn)
  if (v === 'N2CO' || v === 'N2WO' || v === 'N2CC') {
    return { state: openRoutes.length ? 'open' : 'closed', note: `egress on ${openRoutes.length} of ${routes.length} routes (${openRoutes.join(', ') || 'none'}); frame replaced on ${replacedFrame.join(', ') || 'none'}; wrapper replaced on ${replacedWrapper.join(', ') || 'none'}` }
  }
  const state: State = openRoutes.length ? 'open' : measurable.length ? 'closed' : 'not measured'
  return { state, note: `egress on ${openRoutes.length} of ${routes.length} routes (${openRoutes.join(', ') || 'none'}); control shows egress or replacement on ${measurable.length} routes; frame replaced on ${replacedFrame.join(', ') || 'none'}; wrapper replaced on ${replacedWrapper.join(', ') || 'none'}` }
}

const dnsCell = (s: string, v: string): Cell => {
  const st = stats[s][v]
  const check = existsSync(join(dir, s, 'dns-check.json')) ? JSON.parse(readFileSync(join(dir, s, 'dns-check.json'), 'utf8')) : null
  if (!check || !check.queries?.length) return { state: 'not measured', note: `resolver check logged no query (${check ? `exit ${check.exitCode}` : 'no check file'})` }
  if (!st) return { state: 'not measured', note: 'no result' }
  const routes = ROUTES.filter((r) => r.endsWith('-dns'))
  const control = stats[s][v.startsWith('N2W') ? 'N2WO' : 'N2CO']
  const shown = routes.filter((r) => control && control[r].dns > 0)
  const open = routes.filter((r) => egress(st[r]))
  const note = routes.map((r) => `${r}: ${st[r].dns} DNS, ${st[r].requests} req, ${st[r].bare} TCP only`).join('; ')
  if (v.endsWith('O')) return { state: open.length ? 'open' : 'closed', note }
  return { state: open.length ? 'open' : shown.length ? 'closed' : 'not measured', note: `${note}; control logged queries on ${shown.length} routes` }
}

const rtc = (r: Json) => {
  const counts: Record<string, number> = {}
  for (const d of r.udp ?? []) counts[d.route] = (counts[d.route] ?? 0) + 1
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const R = titleReport(r, 'A.done')
  const ctors = R ? Object.entries(R.routes ?? {}).map(([k, v]: [string, any]) => `${k}=${String(v.ctor).slice(0, 40)}`).join(' ') : 'no fixture report'
  return { open: total > 0, note: `${total} STUN datagrams${total ? ` (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}; ${ctors}` }
}

const rtcCell = (s: string, v: string, control: string): Cell => {
  const r = load(s, v)
  const k = skip(r)
  if (k) return { state: 'not measured', note: k }
  const m = rtc(r!)
  if (v === control) return { state: m.open ? 'open' : 'closed', note: m.note }
  const c = load(s, control)
  if (!c || !rtc(c).open) return { state: 'not measured', note: `control ${control} closed; ${m.note}` }
  return { state: m.open ? 'open' : 'closed', note: m.note }
}

const hangCell = (s: string, v: string): Cell => {
  const r = load(s, v)
  const k = skip(r)
  if (k) return { state: 'not measured', note: k }
  const h = r!.report?.notes?.hangResult
  if (!h) return { state: 'not measured', note: 'no hang result' }
  if (v === 'HX') return { state: h.during.maxGapMs > 1000 ? 'open' : 'closed', note: `host gap ${h.during.maxGapMs} ms` }
  const hx = load(s, 'HX')?.report?.notes?.hangResult
  const rm = h.removal ?? {}
  const note = `main page gap ${h.during.maxGapMs} ms over ${h.loopMs} ms of loop; wrapper gap ${h.wrapperDuring.maxGapMs} ms (${h.wrapperDuring.beats} beats, ${h.wrapperBefore.maxGapMs} ms before); document beats ${h.documentDuring.beats} (${h.documentBefore.maxGapMs} ms gap before); ${rm.action} ${rm.completed ? `done ${rm.doneMs} ms after the call` : 'not completed in 10 s'}; main page gap after removal ${h.afterRemoval.maxGapMs} ms`
  if (h.documentDuring.maxGapMs < h.loopMs * 0.8) return { state: 'not measured', note: `document did not hang; ${note}` }
  if (!hx || hx.during.maxGapMs <= 1000) return { state: 'not measured', note: `control HX closed; ${note}` }
  return { state: h.during.maxGapMs > 1000 || !rm.completed ? 'open' : 'closed', note }
}

const ipcCell = (s: string, v: string, control: string): Cell => {
  const r = load(s, v)
  const k = skip(r)
  if (k) return { state: 'not measured', note: k }
  const ran = (r!.markers ?? []).filter((m: Json) => String(m.token).startsWith(`${v}.A.`))
  const routes = [...new Set(ran.map((m: Json) => String(m.token).split('.').slice(2).join('.')))]
  const host = r!.report?.events?.['host.hostcall']?.data?.report
  const note = `${r!.report?.notes?.pattern} pattern; fixture commands run ${ran.length}${routes.length ? ` (${routes.join(', ')})` : ''}; host's own call ${host?.ok ? 'ran' : 'failed'}`
  if (v === control) return { state: ran.length ? 'open' : 'closed', note }
  const c = load(s, control)
  const cRan = (c?.markers ?? []).filter((m: Json) => String(m.token).startsWith(`${control}.A.`)).length
  if (!cRan) return { state: 'not measured', note: `control ${control} ran no command; ${note}` }
  if (!host?.ok) return { state: 'not measured', note: `host's own call failed; ${note}` }
  return { state: ran.length ? 'open' : 'closed', note }
}

const storageCell = (s: string, v: string): Cell => {
  const r1 = load(s, v)
  const r2 = load(s, `${v}-2`)
  const k = skip(r1) ?? skip(r2)
  if (k) return { state: 'not measured', note: k }
  let cross = false
  const parts: string[] = []
  for (const [r, phases] of [[r1!, ['write', 'reload1']], [r2!, ['launch2load1']]] as const) {
    for (const app of ['A', 'B']) {
      for (const ph of phases) {
        const R = titleReport(r, `${app}.done-${ph}`)
        if (!R) {
          parts.push(`${app} ${ph}: no report`)
          continue
        }
        const rd = R.read ?? {}
        const sib = rd.sibling?.value
        const idbSib = rd.idbSibling?.value
        if ((sib && sib !== 'null') || (idbSib && idbSib !== 'absent')) cross = true
        parts.push(`${app} ${ph}: own ${rd.own?.value ?? rd.own?.error?.slice(0, 40)}, sibling ${sib ?? rd.sibling?.error?.slice(0, 40)}`)
      }
    }
  }
  const note = parts.join('; ')
  if (v === 'S2X') return { state: cross ? 'open' : 'closed', note }
  if (storageCell(s, 'S2X').state !== 'open') return { state: 'not measured', note: `control S2X closed; ${note}` }
  return { state: cross ? 'open' : 'closed', note }
}

type Row = { row: string; variant: string; setting: string; cell: (s: string) => Cell }
const rows: Row[] = [
  { row: 'Navigation egress', variant: 'N2CO', setting: 'child, frame-src unlimited, no guard (control)', cell: (s) => navCell(s, 'N2CO') },
  { row: 'Navigation egress', variant: 'N2CC', setting: 'child, frame-src unlimited, guard (brief control)', cell: (s) => navCell(s, 'N2CC') },
  { row: 'Navigation egress', variant: 'N2C', setting: 'child, two-layer container', cell: (s) => navCell(s, 'N2C') },
  { row: 'Navigation egress', variant: 'N2WO', setting: 'window, frame-src unlimited, no guard (control)', cell: (s) => navCell(s, 'N2WO') },
  { row: 'Navigation egress', variant: 'N2W', setting: 'window, two-layer container', cell: (s) => navCell(s, 'N2W') },
  { row: 'Navigation egress by host name', variant: 'N2CO', setting: 'child control', cell: (s) => dnsCell(s, 'N2CO') },
  { row: 'Navigation egress by host name', variant: 'N2C', setting: 'child, two-layer container', cell: (s) => dnsCell(s, 'N2C') },
  { row: 'Navigation egress by host name', variant: 'N2WO', setting: 'window control', cell: (s) => dnsCell(s, 'N2WO') },
  { row: 'Navigation egress by host name', variant: 'N2W', setting: 'window, two-layer container', cell: (s) => dnsCell(s, 'N2W') },
  { row: 'WebRTC egress', variant: 'R2C0', setting: 'child, no init script (control)', cell: (s) => rtcCell(s, 'R2C0', 'R2C0') },
  { row: 'WebRTC egress', variant: 'R2C1', setting: 'child, two-layer container', cell: (s) => rtcCell(s, 'R2C1', 'R2C0') },
  { row: 'WebRTC egress', variant: 'R2W0', setting: 'window, no init script (control)', cell: (s) => rtcCell(s, 'R2W0', 'R2W0') },
  { row: 'WebRTC egress', variant: 'R2W1', setting: 'window, two-layer container', cell: (s) => rtcCell(s, 'R2W1', 'R2W0') },
  { row: 'Host stall', variant: 'HX', setting: 'host blocks itself 3000 ms (control)', cell: (s) => hangCell(s, 'HX') },
  { row: 'Host stall', variant: 'H2C', setting: 'child, two-layer container', cell: (s) => hangCell(s, 'H2C') },
  { row: 'Host stall', variant: 'H2W', setting: 'window, two-layer container', cell: (s) => hangCell(s, 'H2W') },
  { row: 'Invoke key', variant: 'K2CC', setting: 'child granted the command, frame allow-same-origin, brownfield (control)', cell: (s) => ipcCell(s, 'K2CC', 'K2CC') },
  { row: 'Invoke key', variant: 'K2C', setting: 'child, two-layer container, brownfield', cell: (s) => ipcCell(s, 'K2C', 'K2CC') },
  { row: 'Invoke key', variant: 'K2W', setting: 'window, two-layer container, brownfield', cell: (s) => ipcCell(s, 'K2W', 'K2CC') },
  { row: 'Invoke key', variant: 'X2CC', setting: 'child granted, frame allow-same-origin, isolation (control)', cell: (s) => ipcCell(s, 'X2CC', 'X2CC') },
  { row: 'Invoke key', variant: 'X2C', setting: 'child, two-layer container, isolation', cell: (s) => ipcCell(s, 'X2C', 'X2CC') },
  { row: 'Invoke key', variant: 'X2W', setting: 'window, two-layer container, isolation', cell: (s) => ipcCell(s, 'X2W', 'X2CC') },
  { row: 'Storage', variant: 'S2X', setting: 'two windows on one scheme, frames allow-same-origin (control)', cell: (s) => storageCell(s, 'S2X') },
  { row: 'Storage', variant: 'S2C', setting: 'two children, two-layer container', cell: (s) => storageCell(s, 'S2C') },
  { row: 'Storage', variant: 'S2W', setting: 'two windows, two-layer container', cell: (s) => storageCell(s, 'S2W') },
]

const esc = (t: string) => t.replace(/\|/g, '/').replace(/\n/g, ' ')
out.push('')
out.push('### Rows')
out.push('')
out.push(`| Row | Variant | Setting | ${systems.map((s) => engine[s]).join(' | ')} |`)
out.push(`| --- | --- | --- | ${systems.map(() => '---').join(' | ')} |`)
for (const row of rows) out.push(`| ${row.row} | ${row.variant} | ${row.setting} | ${systems.map((s) => { const c = row.cell(s); return `${c.state}: ${esc(c.note)}` }).join(' | ')} |`)
console.log(out.join('\n'))
