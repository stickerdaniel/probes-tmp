import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Json = Record<string, any>

const dir = process.argv[2] ?? 'results/windows-2025'
const ROUTES = ['assign', 'replace', 'link', 'form-self', 'form-blank', 'form-top', 'form-parent', 'meta', 'open', 'download', 'nested', 'assign-dns', 'link-dns', 'nested-dns']
const GROUPS: Record<string, string[]> = {
  'IP literal, 6 routes': ['assign', 'replace', 'link', 'meta', 'download', 'nested'],
  'host name, 3 routes': ['assign-dns', 'link-dns', 'nested-dns'],
  'sandbox-closed, 5 routes': ['form-self', 'form-blank', 'form-top', 'form-parent', 'open'],
}
const CANDIDATES: [string, string][] = [
  ['', 'stock arguments (control)'],
  ['H', '--host-resolver-rules'],
  ['P', '--proxy-server to a closing listener'],
  ['B', 'host resolver rules and proxy'],
  ['F', '--disable-features with preconnect and prediction features'],
  ['N', 'FrameNavigationStarting cancel'],
]

const load = (v: string): Json | null => {
  const p = join(dir, `${v}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

type Count = { req: number; tcp: number; proxy: number; dns: number; replaced: number; reports: number; cancelled: number }

const routeOf = (r: Json) => {
  const notes = r.report?.notes ?? {}
  const starts = ROUTES.map((route) => ({ route, at: r.startedAt + (notes[`route.${route}`]?.startedMs ?? 0) })).sort((a, b) => a.at - b.at)
  return (line: string, t: number) => /\/nav-([a-z-]+)/.exec(line)?.[1] ?? starts.filter((s) => s.at <= t).at(-1)?.route
}

const counts = (r: Json): Record<string, Count> => {
  const out: Record<string, Count> = Object.fromEntries(ROUTES.map((x) => [x, { req: 0, tcp: 0, proxy: 0, dns: 0, replaced: 0, reports: 0, cancelled: 0 }]))
  const at = routeOf(r)
  for (const h of r.sink ?? []) {
    const route = at(h.firstLine ?? '', h.t)
    if (!route || !out[route]) continue
    if (h.firstLine) out[route].req++
    else out[route].tcp++
  }
  for (const h of r.proxy ?? []) {
    if (h.firstLine && !/127\.0\.0\.1|wp\.test/.test(h.firstLine)) continue
    const route = at(h.firstLine ?? '', h.t)
    if (route && out[route]) out[route].proxy++
  }
  for (const q of r.dns ?? []) {
    const route = ROUTES.find((x) => x.endsWith('-dns') && q.name.startsWith(`${x.slice(0, -4)}-`))
    if (route) out[route].dns++
  }
  for (const n of r.report?.navigations ?? []) {
    const m = /\/nav-([a-z-]+)/.exec(n.url ?? '')
    if (n.frame && n.allow === false && m && out[m[1]]) out[m[1]].cancelled++
  }
  for (const route of ROUTES) {
    const rep = r.report?.events?.[`A.nav-${route}`]?.data?.report
    if (rep) {
      out[route].reports++
      if (!rep.pong) out[route].replaced++
    }
  }
  return out
}

const sum = (c: Record<string, Count>, routes: string[]) =>
  routes.reduce((a, r) => ({ req: a.req + c[r].req, tcp: a.tcp + c[r].tcp, proxy: a.proxy + c[r].proxy, dns: a.dns + c[r].dns, replaced: a.replaced + c[r].replaced, reports: a.reports + c[r].reports, cancelled: a.cancelled + c[r].cancelled }), { req: 0, tcp: 0, proxy: 0, dns: 0, replaced: 0, reports: 0, cancelled: 0 })

const health = (r: Json) => {
  const host = r.report?.events?.['host.info']?.data?.report
  const ready = r.report?.events?.['A.navready-none']
  const args = (r.webviewProcesses ?? []).map((l: string) => (l.match(/--(host-resolver-rules|proxy-server|proxy-bypass-list|disable-features)=("[^"]*"|\S+)/g) ?? []).join(' ')).join(' / ')
  const runtime = (r.proxy ?? []).filter((h: Json) => h.firstLine && !/127\.0\.0\.1|wp\.test/.test(h.firstLine)).map((h: Json) => h.firstLine.split(' ')[1])
  return `${runtime.length ? `proxy CONNECT from the runtime: ${runtime.join(', ')}; ` : ''}host page ${host ? `loaded (${host.href})` : 'no report'}; wrapper ${ready ? 'loaded' : 'no report'}; complete ${r.report?.complete}; frame cancel ${r.report?.notes?.frameCancel ?? 'off'}; args ${args || 'none recorded'}`
}

const out: string[] = []
out.push('| Candidate | Layer 1 | Route group | Sink requests | Sink TCP without request | Proxy connections | Resolver queries | Frame replaced | Frame navigations cancelled |')
out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
const notes: string[] = []
for (const [suffix, name] of CANDIDATES) {
  for (const layer of ['C', 'W']) {
    const v = `N2${layer}${suffix}`
    const r = load(v)
    if (!r?.report) {
      out.push(`| ${name} | ${layer === 'C' ? 'child' : 'window'} (${v}) | all | no result | | | | | |`)
      continue
    }
    const c = counts(r)
    for (const [g, routes] of Object.entries(GROUPS)) {
      const s = sum(c, routes)
      out.push(`| ${name} | ${layer === 'C' ? 'child' : 'window'} (${v}) | ${g} | ${s.req} | ${s.tcp} | ${s.proxy} | ${s.dns} | ${s.replaced} of ${s.reports} | ${s.cancelled} |`)
    }
    notes.push(`- ${v}: ${health(r)}`)
  }
}
out.push('')
out.push('| Candidate | Variant | STUN datagrams | Constructors |')
out.push('| --- | --- | --- | --- |')
for (const [suffix, name] of [['0', 'no init script (control)'], ['1', 'stock arguments'], ...CANDIDATES.slice(1)] as [string, string][]) {
  const v = `R2C${suffix}`
  const r = load(v)
  const R = r?.report?.events?.['A.done']?.data?.report
  const ctors = R ? Object.entries(R.routes ?? {}).map(([k, x]: [string, any]) => `${k}=${String(x.ctor).split(':')[0]}`).join(' ') : 'no report'
  out.push(`| ${name} | ${v} | ${(r?.udp ?? []).length} | ${ctors} |`)
}
out.push('')
out.push(...notes)
console.log(out.join('\n'))
