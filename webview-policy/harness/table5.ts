import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

type Json = Record<string, any>

const sets: Record<string, string[]> = { ci: [], docs: [] }
let mode = 'ci'
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) mode = a.slice(2)
  else sets[mode].push(a)
}
const ENGINE: Record<string, string> = { 'macos-15': 'WKWebView', 'windows-2025': 'WebView2', 'ubuntu-24.04': 'WebKitGTK' }
const engine = (dir: string) => ENGINE[basename(dir)] ?? basename(dir)
const load = (dir: string, file: string): Json | null => {
  const p = join(dir, `${file}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
const ev = (r: Json | null, key: string) => r?.report?.events?.[key]?.data?.report
const val = (x: Json | undefined) => (!x ? 'n/a' : x.ok ? String(x.value) : String(x.error).slice(0, 40))
const out: string[] = []
const notes: string[] = []

const EXITS = ['bg', 'bgsheet', 'import', 'font', 'imageset', 'img', 'srcset', 'picture', 'link', 'preload', 'svgimg', 'svgbg', 'cursor', 'liststyle', 'border', 'mask', 'content', 'video', 'input']

if (sets.ci.length) {
  out.push('## Point 1: style and images', '')
  out.push('| Engine | Variant | style element | style attribute | data: image | CSSOM | Exits tried | Sink requests | Sink TCP without request | Resolver queries | Violations |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const dir of sets.ci) {
    for (const v of ['Y3C', 'Y3W', 'Y3CH', 'Y3WH']) {
      const r = load(dir, v)
      const R = ev(r, 'A.done')
      if (!R) {
        out.push(`| ${engine(dir)} | ${v} | ${r ? 'no report' : 'no result'} | | | | | | | | |`)
        continue
      }
      const sink = r!.sink ?? []
      const dns = r!.dns ?? []
      const tried = Object.values(R.exits ?? {}).filter((x: any) => x.ok).length
      out.push(`| ${engine(dir)} | ${v} | ${val(R.render?.styleElement)} | ${val(R.render?.styleAttribute)} | ${val(R.render?.dataImage)} | ${val(R.render?.cssom)} | ${tried} of ${EXITS.length * 2} | ${sink.filter((h: Json) => h.firstLine).length} | ${sink.filter((h: Json) => !h.firstLine).length} | ${dns.length} | ${(R.violations ?? []).length} |`)
      if (sink.length || dns.length) notes.push(`- ${engine(dir)} ${v}: sink ${sink.map((h: Json) => h.firstLine || `tcp host ${h.host}`).join(', ')}; queries ${dns.map((q: Json) => q.name).join(', ')}`)
      const byDir: Record<string, number> = {}
      for (const x of R.violations ?? []) byDir[String(x).split(' ')[0]] = (byDir[String(x).split(' ')[0]] ?? 0) + 1
      notes.push(`- ${engine(dir)} ${v} violations by directive: ${Object.entries(byDir).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; failed tries ${Object.entries(R.exits ?? {}).filter(([, x]: [string, any]) => !x.ok).map(([k, x]: [string, any]) => `${k}: ${String(x.error).slice(0, 60)}`).join('; ') || 'none'}`)
    }
  }
  out.push('', ...notes.splice(0))

  out.push('', '## Point 2: hashes computed by the host', '')
  const SCRIPTS = ['s1-sha256', 's2-sha384', 's3-sha512', 's4-unhashed', 's5-crlf-raw', 's6-crlf-lf', 's7-trimmed', 's8-utf8-é']
  const RUNTIME = ['dyn-new', 'eval', 'function', 'timeout-string', 'onclick', 'javascript-url']
  out.push(`| Engine | Variant | ${SCRIPTS.join(' | ')} | ${RUNTIME.join(' | ')} | re-inserted s1 |`)
  out.push(`| --- | --- | ${SCRIPTS.map(() => '---').join(' | ')} | ${RUNTIME.map(() => '---').join(' | ')} | --- |`)
  for (const dir of sets.ci) {
    for (const v of ['Z3C', 'Z3W']) {
      const R = ev(load(dir, v), 'A.done')
      if (!R) {
        out.push(`| ${engine(dir)} | ${v} | no report |`)
        continue
      }
      const start: string[] = R.ranAtStart ?? []
      const ran: string[] = R.ran ?? []
      const twice = ran.filter((x) => x === 's1-sha256').length > 1
      out.push(`| ${engine(dir)} | ${v} | ${SCRIPTS.map((s) => (start.includes(s) ? 'ran' : 'blocked')).join(' | ')} | ${RUNTIME.map((s) => (ran.includes(s) ? 'ran' : 'blocked')).join(' | ')} | ${twice ? 'ran' : 'blocked'} |`)
    }
  }

  out.push('', '## Point 3: containers with no surface (candidate S)', '')
  out.push('| Engine | Variant | Surface | Ready | 1 s timer ticks in document | Host-seen beats in first 60 s | Max beat gap ms | rAF callbacks | Visibility | Bridge first, last | Host event | WebContent or renderer processes before / after close | RSS KiB before / after |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const MODES: [string, string][] = [
    ['V', 'visible window (control)'],
    ['H', 'hidden window'],
    ['X', 'hidden window, scheduling setting'],
    ['N', 'host and container hidden'],
    ['A', 'host and container hidden, scheduling setting and activity'],
    ['C', 'visible child (control)'],
    ['Z', 'child of size 0'],
    ['O', 'child off screen'],
    ['K', 'child hidden by hide()'],
  ]
  const content = (p: Json | undefined) => {
    if (!p?.byKind) return 'n/a'
    const keys = Object.keys(p.byKind).filter((k) => /WebContent|WebKitWebProcess|renderer/.test(k))
    return { n: keys.reduce((a, k) => a + p.byKind[k].count, 0), kib: keys.reduce((a, k) => a + p.byKind[k].rssKiB, 0) }
  }
  for (const dir of sets.ci) {
    for (const [m, name] of MODES) {
      const v = `V3S${m}`
      const r = load(dir, v)
      const sf = r?.report?.notes?.surface
      const R = ev(r, 'A.done')
      if (!r?.report) {
        out.push(`| ${engine(dir)} | ${v} | ${name} | ${r ? 'no report' : 'no result'} | | | | | | | | | |`)
        continue
      }
      const b = content(sf?.before) as Json
      const a = content(sf?.after) as Json
      const bridge = (x: Json | undefined) => (!x ? 'n/a' : x.reply ? `ok ${Math.round(x.ms)} ms` : String(x.error ?? 'fail').slice(0, 30))
      out.push(`| ${engine(dir)} | ${v} | ${name} | ${r.report.events?.['A.ready'] ? 'yes' : 'no'} | ${R ? `${R.ticks} in ${Math.round(R.elapsedMs / 1000)} s` : 'no report'} | ${sf?.beatsIn60s ?? 'n/a'} | ${sf?.maxGapMs ?? 'n/a'} | ${R?.rafs ?? 'n/a'} | ${R ? `${(R.visibility ?? []).join(' ')} end ${R.visibilityEnd}` : 'n/a'} | ${bridge(R?.first)}, ${bridge(R?.last)} | ${R ? (R.events ?? []).length : 'n/a'} | ${b?.n ?? 'n/a'} / ${a?.n ?? 'n/a'} | ${b?.kib ?? 'n/a'} / ${a?.kib ?? 'n/a'} |`)
      notes.push(`- ${engine(dir)} ${v}: notes ${JSON.stringify({ inactive: r.report.notes?.inactiveSchedulingPolicy, hide: r.report.notes?.childHide, args: r.report.notes?.browserArgs, close: sf?.close, done: sf?.done })}`)
    }
  }
  out.push('', ...notes.splice(0))

  out.push('', '## Point 4: memory of the web view processes', '')
  out.push('| Engine | Variant | Containers | 0 open: processes / RSS MiB | 1 open | 4 open | Per added container MiB (1 to 4) | Method |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  const MEM: [string, string][] = [
    ['M3V', 'visible windows'],
    ['M3H', 'hidden windows'],
    ['M3C', 'visible children'],
    ['M3Z', 'children of size 0'],
  ]
  for (const dir of sets.ci) {
    for (const [v, name] of MEM) {
      const m = load(dir, v)?.report?.notes?.memory
      if (!m) {
        out.push(`| ${engine(dir)} | ${v} | ${name} | no report | | | | |`)
        continue
      }
      const cell = (p: Json) => `${p.count} / ${(p.totalKiB / 1024).toFixed(0)}`
      out.push(`| ${engine(dir)} | ${v} | ${name} | ${cell(m.zero)} | ${cell(m.one)} | ${cell(m.four)} | ${((m.four.totalKiB - m.one.totalKiB) / 3 / 1024).toFixed(0)} | ${m.zero.method}, ${10} s idle before each reading |`)
      notes.push(`- ${engine(dir)} ${v} by kind at 4: ${Object.entries(m.four.byKind ?? {}).map(([k, x]: [string, any]) => `${k} ${x.count} x, ${(x.rssKiB / 1024).toFixed(0)} MiB`).join('; ')}; first container ready ${m.firstReady}`)
    }
  }
  out.push('', ...notes.splice(0))
}

if (sets.docs.length) {
  out.push('', '## Point 5: authored documents in the container (macOS, local build)', '')
  out.push('| Document | Violations by directive | Scripts blocked | Script errors | Host calls ok of n | Headings in view | Text chars in view | Style sheets with rules | First screen rendered |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const root of sets.docs) {
    const index: Json[] = existsSync(join(root, 'index.json')) ? JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) : []
    for (const sub of readdirSync(root).filter((d) => /^\d+$/.test(d)).sort()) {
      const r = load(join(root, sub), 'D3S')
      const R = ev(r, 'A.done')
      const name = index.find((x) => String(x.n).padStart(2, '0') === sub)?.doc ?? sub
      if (!R) {
        out.push(`| ${name} | ${r ? 'no report' : 'no result'} | | | | | | | no report |`)
        continue
      }
      const by = Object.entries(R.byDirective ?? {}).map(([k, n]) => `${k} ${n}`).join(', ') || '0'
      const blocked = (R.violations ?? []).filter((x: Json) => String(x.directive).startsWith('script-src')).length
      const sheets = (R.sheets ?? []).filter((n: number) => n > 0).length
      const rendered = R.loaded && (R.headings?.length > 0 || R.text >= 40) && sheets > 0 && R.boxes > 0
      out.push(`| ${name} | ${by} | ${blocked} | ${(R.errors ?? []).length} | ${R.hostCalls ? `${R.hostCalls.ok} of ${R.hostCalls.n}` : 'n/a'} | ${(R.headings ?? []).length} | ${R.text} | ${sheets} | ${rendered ? 'yes' : 'no'} |`)
      if ((R.violations ?? []).length || (R.errors ?? []).length || R.hostCalls?.errors?.length) notes.push(`- ${name}: violations ${JSON.stringify(R.violations).slice(0, 300)}; errors ${JSON.stringify(R.errors).slice(0, 300)}; host errors ${JSON.stringify(R.hostCalls?.errors ?? [])}`)
    }
  }
  out.push('', ...notes.splice(0))
}

console.log(out.join('\n'))
