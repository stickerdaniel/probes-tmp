;(async function host() {
  const err = (e) => `${(e && e.name) || 'Error'}: ${String((e && e.message) || e).slice(0, 300)}`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const event = (app, kind, data) => invoke('probe_event', { app, kind, data }).catch(() => {})
  const cfg = await invoke('probe_config')
  event('host', 'info', { href: location.href, readyMs: Math.round(performance.now()) })
  if (cfg.pattern === 'isolation') {
    for (let i = 0; i < 50 && !document.querySelector('iframe#__tauri_isolation__'); i++) await wait(100)
    const iso = document.querySelector('iframe#__tauri_isolation__')
    event('host', 'isolation', { src: iso ? iso.src : null })
  }

  if (cfg.group === 'Hang') setInterval(() => invoke('probe_heartbeat').catch(() => {}), 100)

  window.__probeHostHang = (ms) => {
    const until = performance.now() + ms
    while (performance.now() < until) {}
  }

  const frames = {}
  addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.probe !== 1) return
    if (d.kind === 'hb') return invoke('probe_heartbeat', { source: d.app }).catch(() => {})
    const source = Object.keys(frames).find((a) => frames[a].contentWindow === e.source) || 'unknown'
    event(d.app, d.kind, { source, origin: e.origin, report: d.data })
  })
  window.__probeHang = () => Object.values(frames).forEach((f) => f.contentWindow.postMessage({ probeHang: 1 }, '*'))
  window.__probeRemove = () => {
    Object.values(frames).forEach((f) => f.remove())
    event('host', 'removed', { at: performance.now() })
  }
  for (const f of cfg.frames) {
    const el = document.createElement('iframe')
    el.setAttribute('sandbox', f.sandbox)
    if (f.srcdoc) el.srcdoc = f.srcdoc
    else el.src = f.src
    frames[f.app] = el
    document.body.appendChild(el)
  }

  if (cfg.group === 'Ipc') {
    await wait(500)
    let r
    try {
      r = { ok: true, value: await invoke('probe_mark', { token: `${cfg.variant}.host.own` }) }
    } catch (e) {
      r = { ok: false, error: err(e) }
    }
    event('host', 'hostcall', r)
  }

  if (cfg.group === 'Storage') {
    const idb = (name, write) =>
      new Promise((resolve) => {
        try {
          const rq = indexedDB.open(name)
          rq.onupgradeneeded = () => write && rq.result.createObjectStore('kv')
          rq.onerror = () => resolve(err(rq.error))
          rq.onsuccess = () => {
            const db = rq.result
            if (!db.objectStoreNames.contains('kv')) return db.close(), resolve('absent')
            const tx = db.transaction('kv', write ? 'readwrite' : 'readonly')
            const op = write ? tx.objectStore('kv').put(write, 'v') : tx.objectStore('kv').get('v')
            op.onsuccess = () => resolve(write ? 'wrote' : String(op.result))
            op.onerror = () => resolve(err(op.error))
            tx.oncomplete = () => db.close()
          }
        } catch (e) {
          resolve(err(e))
        }
      })
    const R = {}
    if (cfg.launch === 1) {
      localStorage.setItem('host_secret', `HOST-SECRET-${cfg.variant}`)
      R.wroteIdb = await idb('hostdb', `HOST-SECRET-IDB-${cfg.variant}`)
    }
    R.localStorage = Object.keys(localStorage).sort().map((k) => `${k}=${localStorage.getItem(k)}`).join(',')
    R.idb = await idb('hostdb')
    event('host', `storage-launch${cfg.launch}`, R)
  }
})().catch((e) => window.__TAURI_INTERNALS__.invoke('probe_event', { app: 'host', kind: 'fatal', data: String((e && e.stack) || e) }))
