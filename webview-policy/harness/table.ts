import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Json = Record<string, any>
type State = 'closed' | 'open' | 'not measured'
type Cell = { state: State; note: string }

const dir = process.argv[2] ?? 'results'
const systems = readdirSync(dir).filter((s) => existsSync(join(dir, s, 'RF0.json'))).sort()
const engineName: Record<string, string> = { 'macos-15': 'WKWebView', 'windows-2025': 'WebView2', 'ubuntu-24.04': 'WebKitGTK' }

const load = (system: string, file: string): Json | null => {
  const p = join(dir, system, `${file}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

const reportOf = (r: Json | null, key: string): Json | null => {
  const e = r?.report?.events?.[key]?.data
  if (!e) return null
  return e.via === 'host' ? e.report?.report ?? null : e.report ?? null
}

const skip = (r: Json | null): string | null => {
  if (!r) return 'no result file'
  if (r.notApplicable) return r.notApplicable
  if (r.notRun) return r.notRun
  if (!r.report) return `no report, exit ${r.exitCode}`
  return null
}

const byRoute = (r: Json) => {
  const counts: Record<string, number> = {}
  for (const d of r.udp ?? []) counts[d.route] = (counts[d.route] ?? 0) + 1
  return counts
}

const rtc = (r: Json): { open: boolean; note: string } => {
  const counts = byRoute(r)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const R = reportOf(r, 'A.done')
  const ctors = R ? Object.entries(R.routes ?? {}).map(([k, v]: [string, any]) => `${k}=${v.ctor}`).join(' ') : 'no fixture report'
  const routes = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')
  const init = R?.identity?.init?.value
  const peer = r.report?.notes?.peerConnectionEnabled
  const extra = [init && init !== 'undefined' ? 'init script ran' : null, peer ? `_peerConnectionEnabled ${peer.before} to ${peer.after}` : null].filter(Boolean).join(', ')
  return { open: total > 0, note: `${total} STUN datagrams${routes ? ` (${routes})` : ''}; constructors: ${ctors}${extra ? `; ${extra}` : ''}` }
}

const nav = (r: Json): { open: boolean; note: string } => {
  const counts: Record<string, number> = {}
  for (const h of r.sink ?? []) {
    const m = /\/nav-([a-z-]+)/.exec(h.firstLine ?? '')
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const blocked = (r.report?.navigations ?? []).filter((n: Json) => n.allow === false).length
  const routes = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')
  const dl = (r.report?.downloads ?? []).length
  const nw = (r.report?.newWindows ?? []).length
  return { open: total > 0, note: `${total} sink connections${routes ? ` (${routes})` : ''}; on_navigation denied ${blocked}, on_new_window calls ${nw}, on_download calls ${dl}` }
}

const ipc = (r: Json): { open: boolean; note: string; hostOk: boolean } => {
  const ran = (r.markers ?? []).filter((m: Json) => String(m.token).startsWith(`${r.variant}.A.`))
  const routes = [...new Set(ran.map((m: Json) => String(m.token).split('.').slice(2).join('.')))]
  const host = reportOf(r, 'host.hostcall') ?? r.report?.events?.['host.hostcall']?.data?.report
  const hostOk = Boolean(host?.ok)
  const pattern = r.report?.notes?.pattern
  return { open: ran.length > 0, hostOk, note: `${pattern} pattern; fixture commands run ${ran.length}${routes.length ? ` (${routes.join(', ')})` : ''}; host's own call ${hostOk ? 'ran' : `failed ${JSON.stringify(host?.error ?? host ?? 'no report').slice(0, 120)}`}` }
}

const assets = (r: Json): { open: boolean; note: string } => {
  const R = reportOf(r, 'A.done')
  const foreign = (r.sink ?? []).filter((h: Json) => /asset-/.test(h.firstLine ?? '')).length
  const own = R ? Object.entries(R.own ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') : 'no fixture report'
  return { open: foreign > 0, note: `own: ${own}; other-origin sink connections ${foreign}` }
}

const storage = (system: string, v: string): Cell => {
  const r1 = load(system, v)
  const r2 = load(system, `${v}-2`)
  const s = skip(r1) ?? skip(r2)
  if (s) return { state: 'not measured', note: s }
  const reads: string[] = []
  let cross = false
  for (const [r, phases] of [[r1!, ['write', 'reload1']], [r2!, ['launch2load1']]] as const) {
    for (const app of ['A', 'B']) {
      for (const ph of phases) {
        const R = reportOf(r, `${app}.done-${ph}`)
        if (!R) {
          reads.push(`${app} ${ph}: no report`)
          continue
        }
        const rd = R.read ?? {}
        const sib = rd.sibling?.value
        const host = rd.host?.value
        const idbSib = rd.idbSibling?.value
        if ((sib && sib !== 'null') || (host && host !== 'null') || (idbSib && idbSib !== 'absent')) cross = true
        reads.push(`${app} ${ph}: own ${rd.own?.value ?? rd.own?.error}, idb ${rd.idbOwn?.value ?? rd.idbOwn?.error}, sibling ${sib ?? rd.sibling?.error}, host ${host ?? rd.host?.error}`)
      }
    }
  }
  return { state: cross ? 'open' : 'closed', note: reads.join('; ') }
}

const hang = (r: Json): { open: boolean; note: string; gap: number } => {
  const h = r.report?.notes?.hangResult
  if (!h) return { open: false, gap: -1, note: 'no hang result' }
  const gap = h.during?.maxGapMs ?? -1
  const after = h.afterRemoval?.maxGapMs
  const rm = h.removal ?? {}
  const rmText = rm.action === 'none' ? '' : `; ${rm.action} ${rm.completed ? `done in ${rm.doneMs} ms` : 'not completed in 10 s'}`
  return { open: gap > 1000, gap, note: `longest host heartbeat gap ${gap} ms during 10 s, ${after} ms after removal${rmText}` }
}

type Row = { row: string; container: string; setting: string; variant: string; control: string }
const rows: Row[] = [
  { row: 'WebRTC egress', container: 'frame, opaque origin', setting: 'stock, default-src none (control)', variant: 'RF0', control: 'RF0' },
  { row: 'WebRTC egress', container: 'frame, opaque origin', setting: "CSP meta webrtc 'block'", variant: 'RF1', control: 'RF0' },
  { row: 'WebRTC egress', container: 'frame, custom scheme', setting: "CSP header webrtc 'block'", variant: 'RF2', control: 'RF0' },
  { row: 'WebRTC egress', container: 'frame, opaque origin', setting: 'initialization_script_for_all_frames removes RTC globals', variant: 'RF3', control: 'RF0' },
  { row: 'WebRTC egress', container: 'frame, opaque origin', setting: 'WebView2 --force-webrtc-ip-handling-policy=disable_non_proxied_udp', variant: 'RF4', control: 'RF0' },
  { row: 'WebRTC egress', container: 'frame, opaque origin', setting: 'WKPreferences _setPeerConnectionEnabled:NO (private API)', variant: 'RF5', control: 'RF0' },
  { row: 'WebRTC egress', container: 'window per document', setting: 'stock, default-src none (control)', variant: 'RW0', control: 'RW0' },
  { row: 'WebRTC egress', container: 'window per document', setting: "CSP header webrtc 'block'", variant: 'RW1', control: 'RW0' },
  { row: 'WebRTC egress', container: 'window per document', setting: 'initialization_script_for_all_frames removes RTC globals', variant: 'RW3', control: 'RW0' },
  { row: 'WebRTC egress', container: 'window per document', setting: 'WebView2 --force-webrtc-ip-handling-policy=disable_non_proxied_udp', variant: 'RW4', control: 'RW0' },
  { row: 'WebRTC egress', container: 'window per document', setting: 'WKPreferences _setPeerConnectionEnabled:NO (private API)', variant: 'RW5', control: 'RW0' },
  { row: 'Self-navigation', container: 'window per document', setting: 'stock (control)', variant: 'NW0', control: 'NW0' },
  { row: 'Self-navigation', container: 'window per document', setting: 'on_navigation own scheme, on_new_window Deny, on_download false', variant: 'NW1', control: 'NW0' },
  { row: 'Self-navigation', container: 'child web view', setting: 'stock (control)', variant: 'NC0', control: 'NC0' },
  { row: 'Self-navigation', container: 'child web view', setting: 'on_navigation own scheme, on_new_window Deny, on_download false', variant: 'NC1', control: 'NC0' },
  { row: 'Invoke key in a frame', container: 'frame, allow-same-origin (control)', setting: 'brownfield pattern', variant: 'KFC', control: 'KFC' },
  { row: 'Invoke key in a frame', container: 'frame, opaque origin', setting: 'brownfield pattern', variant: 'KF1', control: 'KFC' },
  { row: 'Invoke key in a frame', container: 'frame, custom scheme', setting: 'brownfield pattern', variant: 'KF2', control: 'KFC' },
  { row: 'Invoke key in a frame', container: 'frame, allow-same-origin (control)', setting: 'isolation pattern', variant: 'XFC', control: 'XFC' },
  { row: 'Invoke key in a frame', container: 'frame, opaque origin', setting: 'isolation pattern', variant: 'XF1', control: 'XFC' },
  { row: 'Invoke key in a frame', container: 'frame, custom scheme', setting: 'isolation pattern', variant: 'XF2', control: 'XFC' },
  { row: 'Other-origin assets', container: 'window per document', setting: 'no policy (control)', variant: 'PWn', control: 'PWn' },
  { row: 'Other-origin assets', container: 'frame, custom scheme', setting: 'header policy naming the app scheme only', variant: 'PF', control: 'PWn' },
  { row: 'Other-origin assets', container: 'window per document', setting: 'header policy naming the app scheme only', variant: 'PW', control: 'PWn' },
  { row: 'Storage across documents', container: 'two windows on one origin (control)', setting: 'stock', variant: 'SX', control: 'SX' },
  { row: 'Storage across documents', container: 'window per document', setting: 'stock, origin per document', variant: 'SW', control: 'SX' },
  { row: 'Storage across documents', container: 'child web view', setting: 'stock, origin per document', variant: 'SC', control: 'SX' },
  { row: 'Host stall', container: 'host self-block 3000 ms (control)', setting: 'stock', variant: 'HX', control: 'HX' },
  { row: 'Host stall', container: 'frame, opaque origin', setting: 'stock', variant: 'HF1', control: 'HX' },
  { row: 'Host stall', container: 'frame, custom scheme', setting: 'stock', variant: 'HF2', control: 'HX' },
  { row: 'Host stall', container: 'window per document', setting: 'stock', variant: 'HW', control: 'HX' },
  { row: 'Host stall', container: 'child web view', setting: 'stock', variant: 'HC', control: 'HX' },
]

const measure = (system: string, v: string): { open: boolean; note: string } | Cell => {
  if (v.startsWith('S')) return storage(system, v)
  const r = load(system, v)
  const s = skip(r)
  if (s) return { state: 'not measured', note: s }
  if (v.startsWith('R')) return rtc(r!)
  if (v.startsWith('N')) return nav(r!)
  if (v.startsWith('K') || v.startsWith('X')) return ipc(r!)
  if (v.startsWith('P')) return assets(r!)
  return hang(r!)
}

const cell = (system: string, row: Row): Cell => {
  const m = measure(system, row.variant)
  if ('state' in m) {
    if (row.variant === row.control || m.state === 'not measured') return m
    const c = cell(system, rows.find((x) => x.variant === row.control)!)
    if (c.state !== 'open') return { state: 'not measured', note: `control ${row.control} ${c.state}; ${m.note}` }
    return m
  }
  if (row.variant === row.control) return { state: m.open ? 'open' : 'closed', note: m.note }
  const c = measure(system, row.control)
  const cOpen = 'state' in c ? c.state === 'open' : c.open
  if (!cOpen) return { state: 'not measured', note: `control ${row.control} did not show the open behaviour; ${m.note}` }
  if ('hostOk' in m && !m.hostOk) return { state: 'not measured', note: `host's own call failed; ${m.note}` }
  return { state: m.open ? 'open' : 'closed', note: m.note }
}

const esc = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ')
const out: string[] = []
out.push(`| Row | Container | Setting | Variant | ${systems.map((s) => `${engineName[s] ?? s}`).join(' | ')} |`)
out.push(`| --- | --- | --- | --- | ${systems.map(() => '---').join(' | ')} |`)
for (const row of rows) {
  const cells = systems.map((s) => {
    const c = cell(s, row)
    return `${c.state}: ${esc(c.note)}`
  })
  out.push(`| ${row.row} | ${row.container} | ${esc(row.setting)} | ${row.variant} | ${cells.join(' | ')} |`)
}
const versions = systems.map((s) => `${engineName[s] ?? s} (${s}): ${load(s, 'RF0')?.report?.webviewVersion ?? 'unknown'}`)
console.log(versions.join('\n'))
console.log('')
console.log(out.join('\n'))
