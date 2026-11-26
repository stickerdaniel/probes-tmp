import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

type Json = Record<string, any>

const sets: Record<string, string[]> = { bridge: [], repeat: [], release: [] }
let mode = 'bridge'
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) mode = a.slice(2)
  else sets[mode].push(a)
}

const ENGINE: Record<string, string> = { 'macos-15': 'WKWebView', 'windows-2025': 'WebView2', 'ubuntu-24.04': 'WebKitGTK' }
const engine = (dir: string) => ENGINE[basename(dir)] ?? basename(dir)
const CANDIDATES: [string, string][] = [
  ['S', 'S, own scheme'],
  ['C', 'C, one command'],
  ['T', 'T, title relay'],
]
const LAYERS: [string, string][] = [
  ['C', 'child'],
  ['W', 'window'],
]
const ROUTES = ['assign', 'replace', 'link', 'form-self', 'form-blank', 'form-top', 'form-parent', 'meta', 'open', 'download', 'nested', 'assign-dns', 'link-dns', 'nested-dns']
const GROUPS: Record<string, string[]> = {
  'IP literal': ['assign', 'replace', 'link', 'meta', 'download', 'nested'],
  'host name': ['assign-dns', 'link-dns', 'nested-dns'],
  'sandbox-closed': ['form-self', 'form-blank', 'form-top', 'form-parent', 'open'],
}

const load = (dir: string, file: string): Json | null => {
  const p = join(dir, `${file}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
const ev = (r: Json | null, key: string) => r?.report?.events?.[key]?.data?.report
const pct = (xs: number[], q: number) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}
const num = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : String(Math.round(v * 10) / 10))
const sizeCell = (x: Json | undefined) => (!x ? 'no report' : x.skipped ? 'skipped' : x.ok ? `ok ${x.ms} ms` : `fail (${String(x.error ?? `lengths ${x.requestLen}/${x.replyLen}`).slice(0, 40)})`)

const directTags = (r: Json) => (r.bridge ?? []).filter((b: Json) => /^(direct|nested)-/.test(String(b.tag ?? '')))
const layerTwoIpc = (r: Json) =>
  (r.ipcPosts ?? (r.trace ?? []).filter((t: Json) => t.t === 'span' && t.name === 'ipc::request' && t.fields?.kind === 'post-message').map((t: Json) => ({ uri: t.fields.uri, request: String(t.fields.request ?? '') }))).filter((t: Json) => /direct-ipc/.test(t.request))

const out: string[] = []
const notes: string[] = []

if (sets.bridge.length) {
  out.push('## Rows 1 to 5: transport, size, direct use, relay discipline, identity', '')
  out.push('| Engine | Candidate | Layer 1 | Round trips ok | Median ms | Max ms | Own identity (A, B) | Event | 1 KiB | 64 KiB | 1 MiB | Direct reached handler | Layer 2 IPC posts seen | Relay dropped | Forged field reply |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const dir of sets.bridge) {
    for (const [c, cname] of CANDIDATES) {
      for (const [l, lname] of LAYERS) {
        const v = `B3${c}${l}`
        const r = load(dir, v)
        const A = ev(r, 'A.done')
        const B = ev(r, 'B.done')
        if (!r?.report || !A) {
          out.push(`| ${engine(dir)} | ${cname} | ${lname} (${v}) | ${r ? 'no report' : 'no result'} | | | | | | | | | | | |`)
          continue
        }
        const ms = [...(A.rt?.ms ?? []), ...(B?.rt?.ms ?? [])]
        const direct = directTags(r)
        const posts = layerTwoIpc(r)
        const dropped = [...(A.wrapper?.relay?.dropped ?? []), ...(B?.wrapper?.relay?.dropped ?? [])]
        out.push(
          `| ${engine(dir)} | ${cname} | ${lname} (${v}) | ${A.rt.ok} + ${B?.rt?.ok ?? 'n/a'} of 200 | ${num(pct(ms, 0.5))} | ${num(ms.length ? Math.max(...ms) : null)} | ${A.rt.ownIdentity}, ${B?.rt?.ownIdentity ?? 'n/a'} | ${A.event?.count ? `${A.event.latencyMs} ms` : 'none'} | ${sizeCell(A.size?.[1024])} | ${sizeCell(A.size?.[65536])} | ${sizeCell(A.size?.[1048576])} | ${direct.length} | ${posts.length} | ${dropped.length} | ${A.relay?.forgedField?.replyApp ?? A.relay?.forgedField?.error ?? 'n/a'} |`,
        )
        const d = A.direct ?? {}
        const brief = (x: Json | undefined) => (!x ? 'n/a' : x.skipped ? `skipped (${String(x.skipped).slice(0, 50)})` : x.timeout ? `timeout ${x.timeout} ms` : x.ok ? String(typeof x.value === 'object' ? JSON.stringify(x.value) : x.value).slice(0, 60) : String(x.error).slice(0, 90))
        notes.push(
          `- ${engine(dir)} ${v}: fetch ${brief(d.fetch)}; no-cors fetch ${brief(d.fetchNoCors)}; beacon ${brief(d.beacon)}; parent internals ${brief(d.parentInternals)}; webkit none ${brief(d['webkit-none'])}, leaked ${brief(d['webkit-leaked'])}; chrome none ${brief(d['chrome-none'])}, leaked ${brief(d['chrome-leaked'])}; parent title ${brief(d.parentTitle)}; top location ${brief(d.topLocation)}; nested frame ${brief(A.relay?.nestedFrame)}; popup ${brief(A.relay?.popup)}; dropped kinds ${dropped.map((x: Json) => `${x.kind}:${x.tag ?? ''}`).join(' ') || 'none'}; handler direct tags ${direct.map((x: Json) => `${x.tag} via ${x.via}`).join(', ') || 'none'}; layer 2 IPC posts ${posts.map((t: Json) => String(t.uri)).join(', ') || 'none'}; url after ${JSON.stringify(r.report?.notes?.['urlAfter.A'] ?? null)}; rt errors ${JSON.stringify(A.rt.errors ?? []).slice(0, 160)}; violations ${(A.violations ?? []).length}`,
        )
      }
    }
  }
  out.push('', ...notes.splice(0))

  out.push('', '## Candidate C under the isolation pattern (X3CC, X3CW)', '')
  out.push('| Engine | Layer 1 | Wrapper own call | READY message | Encrypted replies | Isolation frame | Round trips ok | Console lines |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const dir of sets.bridge) {
    for (const [l, lname] of LAYERS) {
      const v = `X3C${l}`
      const r = load(dir, v)
      const D = ev(r, 'A.wrapper-diag')
      const A = ev(r, 'A.done')
      if (!D) {
        out.push(`| ${engine(dir)} | ${lname} (${v}) | ${r ? 'no report' : 'no result'} | | | | | |`)
        continue
      }
      const msgs = D.diag?.messages ?? []
      out.push(
        `| ${engine(dir)} | ${lname} (${v}) | ${D.own?.ok ? `ok in ${D.own.ms} ms` : `${String(D.own?.error).slice(0, 40)}`} | ${D.diag?.ready ? `from ${D.diag.ready.origin}` : 'none'} | ${msgs.filter((m: Json) => m.kind === 'encrypted').length} | ${D.diag?.isolationFrame ? D.diag.isolationFrame.src : 'absent'} | ${A ? `${A.rt.ok} of 100` : 'no report'} | ${(D.diag?.console ?? []).length} |`,
      )
      notes.push(`- ${engine(dir)} ${v}: pattern ${D.diag?.pattern}; secure ${D.diag?.secure}; subtle ${D.diag?.subtle}; messages ${JSON.stringify(msgs).slice(0, 300)}; console ${JSON.stringify(D.diag?.console ?? []).slice(0, 400)}; violations ${JSON.stringify(D.diag?.violations ?? []).slice(0, 200)}; IPC spans ${(r?.trace ?? []).filter((t: Json) => t.t === 'span' && t.name === 'ipc::request').map((t: Json) => `${t.fields?.kind}:${String(t.fields?.uri ?? '')}`).join(', ')}`)
    }
  }
  out.push('', ...notes.splice(0))
}

const navCounts = (r: Json) => {
  const notesR = r.report?.notes ?? {}
  const starts = ROUTES.map((route) => ({ route, at: r.startedAt + (notesR[`route.${route}`]?.startedMs ?? 0) })).sort((a, b) => a.at - b.at)
  const at = (line: string, t: number) => /\/nav-([a-z-]+)/.exec(line)?.[1] ?? starts.filter((s) => s.at <= t).at(-1)?.route
  const c: Record<string, { req: number; tcp: number; dns: number; replaced: number; reports: number }> = Object.fromEntries(ROUTES.map((x) => [x, { req: 0, tcp: 0, dns: 0, replaced: 0, reports: 0 }]))
  for (const h of r.sink ?? []) {
    const route = at(h.firstLine ?? '', h.t)
    if (!route || !c[route]) continue
    if (h.firstLine) c[route].req++
    else c[route].tcp++
  }
  for (const q of r.dns ?? []) {
    const route = ROUTES.find((x) => x.endsWith('-dns') && q.name.startsWith(`${x.slice(0, -4)}-`))
    if (route) c[route].dns++
  }
  for (const route of ROUTES) {
    const rep = r.report?.events?.[`A.nav-${route}`]?.data?.report
    if (rep) {
      c[route].reports++
      if (!rep.pong) c[route].replaced++
    }
  }
  return Object.fromEntries(
    Object.entries(GROUPS).map(([g, routes]) => [g, routes.reduce((a, x) => ({ req: a.req + c[x].req, tcp: a.tcp + c[x].tcp, dns: a.dns + c[x].dns, replaced: a.replaced + c[x].replaced, reports: a.reports + c[x].reports }), { req: 0, tcp: 0, dns: 0, replaced: 0, reports: 0 })]),
  )
}
const navCell = (r: Json | null) => {
  if (!r?.report) return Object.keys(GROUPS).map(() => (r ? 'no report' : 'no result'))
  const c = navCounts(r)
  return Object.keys(GROUPS).map((g) => `${c[g].req}/${c[g].tcp}/${c[g].dns}, replaced ${c[g].replaced} of ${c[g].reports}`)
}
const stderrLines = (r: Json | null) => [...new Set((r?.stderrTail ?? []).map((l: string) => l.trim()).filter((l: string) => l && !/AT-SPI|DRI3|libEGL/.test(l)))].map((l) => String(l).replace(/^\[[^\]]*\]\s*/, '').slice(0, 140))

const closure = (dirs: string[], title: string, prefix: string) => {
  out.push('', `## ${title}`, '')
  out.push('Cells: sink requests / sink TCP without request / resolver queries.', '')
  out.push('| Engine | Candidate | Layer 1 | IP literal, 6 routes | host name, 3 routes | sandbox-closed, 5 routes | STUN datagrams (R3) | Host page |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const dir of dirs) {
    for (const [c, cname] of CANDIDATES) {
      for (const [l, lname] of LAYERS) {
        const n = load(dir, `${prefix}N3${c}${l}`)
        const rr = load(dir, `${prefix}R3${c}${l}`)
        if (!n && !rr) continue
        const rtc = rr?.report ? `${(rr.udp ?? []).length}` : rr ? 'no report' : 'not run'
        const host = n?.report?.events?.['host.info'] ? 'loaded' : n ? 'no host report' : 'n/a'
        out.push(`| ${engine(dir)} | ${cname} | ${lname} (N3${c}${l}) | ${navCell(n).join(' | ')} | ${rtc} | ${host} |`)
        const err = stderrLines(n)
        if (err.length && engine(dir) === 'WebView2') notes.push(`- ${engine(dir)} N3${c}${l} stderr: ${err.join(' / ')}`)
        if (n?.webviewProcesses?.length) notes.push(`- ${engine(dir)} N3${c}${l} browser args: ${(n.webviewProcesses as string[]).map((x) => (x.match(/--(host-resolver-rules|proxy-server|disable-features)=("[^"]*"|\S+)/g) ?? []).join(' ')).join(' / ')}`)
      }
    }
  }
  out.push('', ...notes.splice(0))
}

if (sets.bridge.length) {
  closure(sets.bridge, 'Row 6: closure with the transport on (WebView2 with the resolver rule)', '')

  out.push('', '## Row 7: stall with the transport on', '')
  out.push('| Engine | Candidate | Layer 1 | Host max gap during loop | Document A beats during | Wrapper A beats during | Document B max gap | Host request to A | Host request to B |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const dir of sets.bridge) {
    for (const [c, cname] of CANDIDATES) {
      for (const [l, lname] of LAYERS) {
        const v = `H3${c}${l}`
        const r = load(dir, v)
        const h = r?.report?.notes?.hangResult
        const q: Json[] = r?.report?.notes?.hostRequests ?? []
        if (!h) {
          out.push(`| ${engine(dir)} | ${cname} | ${lname} (${v}) | ${r ? 'no report' : 'no result'} | | | | | |`)
          continue
        }
        const cell = (x: Json | undefined) => (!x ? 'n/a' : x.replied ? `reply in ${x.replyMs} ms` : `timeout ${x.timeoutMs} ms`)
        out.push(`| ${engine(dir)} | ${cname} | ${lname} (${v}) | ${h.during?.maxGapMs} ms | ${h.documentDuring?.beats} | ${h.wrapperDuring?.beats} | ${h.otherDocumentDuring?.maxGapMs} ms | ${cell(q.find((x) => x.app === 'A'))} | ${cell(q.find((x) => x.app === 'B'))} |`)
      }
    }
  }
}

if (sets.repeat.length) {
  out.push('', '## Navigating rows of sections 7 and 8, three launches each', '')
  out.push('Cells: sink requests / sink TCP without request / resolver queries.', '')
  out.push('| Engine | Variant | Launch | IP literal, 6 routes | host name, 3 routes | sandbox-closed, 5 routes |')
  out.push('| --- | --- | --- | --- | --- | --- |')
  for (const dir of sets.repeat) {
    const files = readdirSync(dir).filter((f) => /^N2[A-Z]+(-r\d)?\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort()
    for (const f of files) {
      const [v, rep] = f.split('-r')
      out.push(`| ${engine(dir)} | ${v} | ${rep ?? '1'} | ${navCell(load(dir, f)).join(' | ')} |`)
    }
  }
}

if (sets.release.length) {
  out.push('', '## Release profile with the chosen candidate', '')
  out.push('| Engine | Variant | Round trips ok | Median ms | Max ms | Direct reached handler | Layer 2 IPC posts seen | IP literal | host name | sandbox-closed | STUN datagrams |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const dir of sets.release) {
    const files = readdirSync(dir).filter((f) => /^[BNR]3[SCT][CW]\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort()
    for (const f of files) {
      const r = load(dir, f)
      if (f.startsWith('B')) {
        const A = ev(r, 'A.done')
        const B = ev(r, 'B.done')
        const ms = [...(A?.rt?.ms ?? []), ...(B?.rt?.ms ?? [])]
        out.push(`| ${engine(dir)} | ${f} (${r?.profile}) | ${A ? `${A.rt.ok} + ${B?.rt?.ok ?? 'n/a'} of 200` : 'no report'} | ${num(pct(ms, 0.5))} | ${num(ms.length ? Math.max(...ms) : null)} | ${r ? directTags(r).length : 'n/a'} | ${r ? layerTwoIpc(r).length : 'n/a'} | | | | |`)
      } else if (f.startsWith('N')) out.push(`| ${engine(dir)} | ${f} (${r?.profile}) | | | | | | ${navCell(r).join(' | ')} | |`)
      else out.push(`| ${engine(dir)} | ${f} (${r?.profile}) | | | | | | | | | ${r?.report ? (r.udp ?? []).length : 'no report'} |`)
    }
  }
}

console.log(out.join('\n'))
