;(async function wrapper() {
  const cfg = JSON.parse(document.getElementById('probe-cfg').textContent)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const err = (e) => `${(e && e.name) || 'Error'}: ${String((e && e.message) || e).slice(0, 200)}`
  const diag = { console: [], violations: [], messages: [], ready: null, isolationFrame: null }
  for (const level of ['error', 'warn']) {
    const orig = console[level]
    console[level] = (...a) => {
      if (diag.console.length < 40) diag.console.push(`${level}: ${a.map((x) => (typeof x === 'string' ? x : err(x))).join(' ').slice(0, 240)}`)
      return orig.apply(console, a)
    }
  }
  document.addEventListener('securitypolicyviolation', (e) => diag.violations.length < 40 && diag.violations.push(`${e.effectiveDirective} ${String(e.blockedURI).slice(0, 100)}`))
  let queue = Promise.resolve()
  const titled = (titles, gap) => {
    const done = queue.then(async () => {
      for (const t of titles) {
        document.title = t
        await wait(gap)
      }
    })
    queue = done
    return done
  }
  const encode = (data) => btoa(unescape(encodeURIComponent(JSON.stringify(data))))
  const chunks = (s, size) => Array.from({ length: Math.ceil(s.length / size) || 1 }, (_, i) => s.slice(i * size, (i + 1) * size))
  const send = (app, kind, data) => {
    const parts = chunks(encode(data), 900)
    const titles = parts.map((c, i) => `PROBE|${app}|${kind}|${i}|${parts.length}|${c}`)
    return titled([...titles, ...titles], 120)
  }
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', cfg.sandbox)
  if (cfg.group === 'Docs') {
    document.body.style.margin = '0'
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0'
  }
  frame.srcdoc = cfg.srcdoc
  let loads = 0
  let pong = null
  const relay = { accepted: 0, dropped: [], requests: 0 }
  frame.addEventListener('load', () => loads++)

  let seq = 0
  const pending = new Map()
  window.__bridgeReply = (id, reply) => {
    const p = pending.get(id)
    pending.delete(id)
    if (p) p(reply)
  }
  const transports = {
    S: async (body) => {
      const r = await fetch(cfg.bridgeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return r.json()
    },
    C: (body) => window.__TAURI_INTERNALS__.invoke('bridge_call', { body }),
    T: (body) =>
      new Promise((resolve) => {
        const id = ++seq
        pending.set(id, resolve)
        const parts = chunks(encode(body), 900)
        titled(parts.map((c, i) => `BRQ|${id}|${i}|${parts.length}|${c}`), 20)
      }),
  }
  const call = (body, ms = 30000) => Promise.race([Promise.resolve().then(() => transports[cfg.bridge](body)), wait(ms).then(() => Promise.reject(new Error(`timeout ${ms} ms`)))])
  const toFrame = (m) => frame.contentWindow && frame.contentWindow.postMessage(m, '*')

  addEventListener('message', (e) => {
    const d = e.data
    if (diag.messages.length < 30 && !(d && d.probe === 1)) {
      diag.messages.push({ origin: e.origin, fromFrame: e.source === frame.contentWindow, kind: d === '__TAURI_ISOLATION_READY__' ? 'ready' : d && typeof d === 'object' && d.payload && d.payload.nonce ? 'encrypted' : typeof d })
      if (d === '__TAURI_ISOLATION_READY__' && !diag.ready) diag.ready = { origin: e.origin, ms: Math.round(performance.now()) }
    }
    if (!d || d.probe !== 1) return
    if (e.source !== frame.contentWindow) {
      relay.dropped.push({ kind: d.kind, tag: d.body && d.body.tag, origin: e.origin })
      return
    }
    if (d.kind === 'hb') {
      document.title = `HB|${d.app}|${Date.now()}`
      return
    }
    if (d.kind === 'pong') {
      pong = d.data
      return
    }
    if (d.kind === 'breq') {
      relay.accepted++
      if (!cfg.bridge) return toFrame({ bres: d.id, error: 'no bridge' })
      call(d.body, d.ms).then(
        (reply) => toFrame({ bres: d.id, reply }),
        (e) => toFrame({ bres: d.id, error: err(e) }),
      )
      return
    }
    if (d.kind === 'relay') return toFrame({ relay: { ...relay, dropped: relay.dropped.slice(0, 20) } })
    if (d.kind === 'done' && cfg.bridge) d.data.wrapper = wrapperReport()
    send(d.app, d.kind, d.data)
  })
  const wrapperReport = () => {
    const iso = document.querySelector('iframe#__tauri_isolation__')
    return {
      relay: { ...relay, dropped: relay.dropped.slice(0, 20) },
      diag: { ...diag, isolationFrame: iso ? { src: iso.src, sandbox: iso.getAttribute('sandbox') } : null, frames: document.querySelectorAll('iframe').length, secure: isSecureContext, subtle: typeof (crypto && crypto.subtle), internals: typeof window.__TAURI_INTERNALS__, pattern: (() => { try { return JSON.stringify(window.__TAURI_INTERNALS__.__TAURI_PATTERN__) } catch (e) { return err(e) } })() },
    }
  }
  window.__bridgeEvent = (ev) => toFrame({ bevent: ev, atMs: Date.now() })
  window.__bridgeHostRequest = (id) => toFrame({ bhost: id })
  window.__probeHang = () => frame.contentWindow.postMessage({ probeHang: 1 }, '*')
  window.__probeDocsReport = () => frame.contentWindow.postMessage({ probeDocsReport: 1 }, '*')
  document.body.appendChild(frame)
  if (cfg.group === 'Hang') {
    let beat = 0
    const src = cfg.app === 'A' ? 'W' : `W${cfg.app}`
    setInterval(() => (document.title = `HB|${src}|${++beat}`), 100)
  }
  if (cfg.group === 'Bridge' && cfg.variant.startsWith('X')) {
    await wait(1500)
    const t0 = performance.now()
    let own
    try {
      own = { ok: true, value: await call({ op: 'ping', tag: 'wrapper-own', n: 0 }, 8000), ms: Math.round(performance.now() - t0) }
    } catch (e) {
      own = { ok: false, error: err(e), ms: Math.round(performance.now() - t0) }
    }
    send(cfg.app, 'wrapper-diag', { own, ...wrapperReport() })
  }
  if (cfg.group === 'Nav' && cfg.route !== 'none') {
    await wait(2800)
    let posted
    try {
      frame.contentWindow.postMessage({ probePing: 1 }, '*')
      posted = 'posted'
    } catch (e) {
      posted = String(e)
    }
    await wait(700)
    send(cfg.app, `nav-${cfg.route}`, { pong: pong !== null, pongData: pong, posted, loads, frames: document.querySelectorAll('iframe').length, wrapperHref: location.href })
  }
})()
