import { createServer, type Socket } from 'node:net'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const system = process.env.PROBE_SYSTEM ?? `${process.platform}-${process.arch}`
const ALL = 'RF0 RF1 RF2 RF3 RF4 RF5 RW0 RW1 RW3 RW4 RW5 NW0 NW1 NC0 NC1 KF1 KF2 KFC XF1 XF2 XFC PF PW PWn SW SW#2 SC SC#2 SX SX#2 HX HF1 HF2 HW HC'
const variants = (process.env.VARIANTS || ALL).split(/\s+/).filter(Boolean)
const exeName = process.platform === 'win32' ? 'webview-policy.exe' : 'webview-policy'
const exe = join(root, 'src-tauri', 'target', 'debug', exeName)
const isoExe = join(root, 'src-tauri-iso', 'target', 'debug', exeName)
const outDir = join(root, 'results', system)
mkdirSync(outDir, { recursive: true })

const onlyOn: Record<string, string> = { RF4: 'win32', RW4: 'win32', RF5: 'darwin', RW5: 'darwin' }
const ROUTES = ['direct', 'saved', 'webkit', 'blank', 'srcdoc', 'open', 'worker']

type Hit = { t: number; variant: string; firstLine: string; upgrade: boolean }
const hits: Hit[] = []
const datagrams: { t: number; variant: string; route: string; bytes: number }[] = []
let current = 'none'

const sink = createServer((socket: Socket) => {
  const variant = current
  let buf = ''
  let done = false
  const finish = () => {
    if (done) return
    done = true
    hits.push({ t: Date.now(), variant, firstLine: buf.split('\r\n')[0] ?? '', upgrade: /\r\nupgrade:\s*websocket/i.test(buf) })
  }
  socket.on('data', (d) => {
    buf += d.toString('latin1')
    if (buf.includes('\r\n\r\n')) {
      finish()
      const dl = /download/.test(buf.split('\r\n')[0] ?? '') ? 'Content-Disposition: attachment; filename="x.txt"\r\n' : ''
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n${dl}Access-Control-Allow-Origin: *\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok`)
    }
  })
  socket.on('error', () => finish())
  socket.on('close', () => finish())
  socket.setTimeout(3000, () => (finish(), socket.destroy()))
})
await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r))
const sinkPort = (sink.address() as { port: number }).port

const udps: UdpSocket[] = []
const stunPorts: number[] = []
for (const route of ROUTES) {
  const u = createSocket('udp4')
  u.on('message', (msg) => datagrams.push({ t: Date.now(), variant: current, route, bytes: msg.length }))
  await new Promise<void>((r) => u.bind(0, '127.0.0.1', r))
  udps.push(u)
  stunPorts.push(u.address().port)
}

const dataDirs = () => {
  const id = 'dev.probe.webviewpolicy'
  const h = homedir()
  if (process.platform === 'darwin') return [join(h, 'Library', 'WebKit', id), join(h, 'Library', 'WebKit', 'webview-policy'), join(h, 'Library', 'Caches', id), join(h, 'Library', 'Caches', 'webview-policy'), join(h, 'Library', 'Application Support', id), join(h, 'Library', 'HTTPStorages', id), join(h, 'Library', 'HTTPStorages', 'webview-policy')]
  if (process.platform === 'win32') return [join(process.env.LOCALAPPDATA ?? join(h, 'AppData', 'Local'), id), join(process.env.APPDATA ?? join(h, 'AppData', 'Roaming'), id)]
  return [join(h, '.local', 'share', id), join(h, '.cache', id), join(h, '.local', 'share', 'webview-policy'), join(h, '.cache', 'webview-policy')]
}

const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) : [])
const json = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const tail = (path: string, n = 60) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').slice(-n) : [])

for (const entry of variants) {
  const [variant, launchText] = entry.split('#')
  const launch = Number(launchText ?? '1')
  const file = join(outDir, `${variant}${launch > 1 ? `-${launch}` : ''}.json`)
  if (onlyOn[variant] && onlyOn[variant] !== process.platform) {
    writeFileSync(file, JSON.stringify({ system, variant, launch, notApplicable: `setting exists only on ${onlyOn[variant]}` }, null, 2))
    console.log(`${system} ${entry}: not applicable`)
    continue
  }
  const binary = variant.startsWith('X') ? isoExe : exe
  if (!existsSync(binary)) {
    writeFileSync(file, JSON.stringify({ system, variant, launch, notRun: `binary ${binary} missing` }, null, 2))
    console.log(`${system} ${entry}: binary missing`)
    continue
  }
  if (launch === 1) for (const d of dataDirs()) rmSync(d, { recursive: true, force: true })
  const dir = mkdtempSync(join(tmpdir(), `probe-${variant}-`))
  const nonce = `${variant}-${launch}-${Date.now().toString(36)}`
  current = entry
  const started = Date.now()
  const proc = Bun.spawn([binary], {
    cwd: dir,
    env: { ...process.env, PROBE_VARIANT: variant, PROBE_LAUNCH: String(launch), PROBE_DIR: dir, PROBE_SINK: `http://127.0.0.1:${sinkPort}`, PROBE_STUN: stunPorts.join(','), PROBE_NONCE: nonce },
    stdout: Bun.file(join(dir, 'stdout.log')),
    stderr: Bun.file(join(dir, 'stderr.log')),
  })
  const processes: Promise<string[]> =
    process.platform === 'win32'
      ? Bun.sleep(5000).then(async () => {
          const ps = Bun.spawn(['powershell', '-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ForEach-Object { $_.CommandLine }"], { stdout: 'pipe' })
          const text = await new Response(ps.stdout).text()
          return [...new Set(text.split(/\r?\n/).filter((l) => !/--type=/.test(l)).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/"[^"]*msedgewebview2\.exe"/, 'msedgewebview2.exe').replace(/--user-data-dir=("[^"]*"|\S+)/, '--user-data-dir=<dir>').slice(0, 600)))]
        })
      : Promise.resolve([])
  let killed = false
  const timer = setTimeout(() => ((killed = true), proc.kill()), 180_000)
  const exitCode = await proc.exited
  clearTimeout(timer)
  await Bun.sleep(1500)
  current = 'none'
  const result = {
    system,
    variant,
    launch,
    nonce,
    exitCode,
    killed,
    durationMs: Date.now() - started,
    report: json(join(dir, 'report.json')),
    markers: lines(join(dir, 'marker.log')),
    trace: lines(join(dir, 'trace.jsonl')).filter((l) => l.t !== 'span' || String(l.name).includes('ipc')).slice(0, 400),
    scheme: lines(join(dir, 'scheme.log')),
    sink: hits.filter((h) => h.variant === entry || h.firstLine.includes(`/e/${variant}/`)),
    udp: datagrams.filter((d) => d.variant === entry),
    downloadFile: existsSync(join(dir, 'download.bin')),
    webviewProcesses: await processes,
    stderrTail: tail(join(dir, 'stderr.log')),
  }
  writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(`${system} ${entry}: exit ${exitCode}, ${result.durationMs} ms, complete ${result.report?.complete}, markers ${result.markers.length}, sink ${result.sink.length}, udp ${result.udp.length}`)
}

writeFileSync(join(outDir, 'unattributed-sink.json'), JSON.stringify(hits.filter((h) => h.variant === 'none'), null, 2))
sink.close()
for (const u of udps) u.close()
process.exit(0)
