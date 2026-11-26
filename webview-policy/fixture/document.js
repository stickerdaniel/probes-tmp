;(async function probe() {
  const savedPeer = window.RTCPeerConnection
  const cfg = JSON.parse(document.getElementById('probe-cfg').textContent)
  const tag = `${cfg.variant}.${cfg.app}`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const err = (e) => `${(e && e.name) || 'Error'}: ${String((e && e.message) || e).slice(0, 200)}`
  const str = (v) => (v === undefined ? 'undefined' : v === null ? 'null' : typeof v === 'string' ? v.slice(0, 200) : typeof v === 'object' || typeof v === 'function' ? typeof v : String(v))
  const attempt = (f) => {
    try {
      return { ok: true, value: str(f()) }
    } catch (e) {
      return { ok: false, error: err(e) }
    }
  }
  const settle = (p, ms) =>
    Promise.race([
      Promise.resolve()
        .then(() => p())
        .then((v) => ({ ok: true, value: typeof v === 'object' && v !== null ? v : str(v) }), (e) => ({ ok: false, error: err(e) })),
      wait(ms).then(() => ({ timeout: ms })),
    ])
  const violations = []
  document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.effectiveDirective} ${String(e.blockedURI).slice(0, 100)}`))
  const sink = (kind) => `${cfg.sink}/e/${cfg.variant}/${cfg.app}/${kind}`
  const framed = cfg.mode === 'frame'

  const send = async (kind, data) => {
    if (framed) {
      parent.postMessage({ probe: 1, app: cfg.app, kind, data }, '*')
      return
    }
    const s = btoa(unescape(encodeURIComponent(JSON.stringify(data))))
    const n = Math.ceil(s.length / 900) || 1
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < n; i++) {
        document.title = `PROBE|${cfg.app}|${kind}|${i}|${n}|${s.slice(i * 900, (i + 1) * 900)}`
        await wait(120)
      }
    }
  }

  const identity = { href: str(location.href), origin: str(self.origin), init: attempt(() => window.__probeInit) }

  const childFrame = (setup) =>
    new Promise((resolve) => {
      try {
        const f = document.createElement('iframe')
        setup(f)
        f.addEventListener('load', () => resolve(f), { once: true })
        document.body.appendChild(f)
        setTimeout(() => resolve(f), 1500)
      } catch (e) {
        resolve(null)
      }
    })

  async function rtc() {
    const R = { identity, routes: {} }
    const ctors = {
      direct: async () => window.RTCPeerConnection,
      saved: async () => savedPeer,
      webkit: async () => window.webkitRTCPeerConnection,
      blank: async () => {
        const f = await childFrame(() => {})
        R.blankInit = attempt(() => f.contentWindow.__probeInit)
        return f.contentWindow.RTCPeerConnection
      },
      srcdoc: async () => {
        const f = await childFrame((el) => (el.srcdoc = '<p>child</p>'))
        R.srcdocInit = attempt(() => f.contentWindow.__probeInit)
        return f.contentWindow.RTCPeerConnection
      },
      open: async () => {
        const w = window.open('about:blank')
        R.openWindow = w === null ? 'null' : 'window'
        await wait(500)
        R.openInit = attempt(() => w.__probeInit)
        return w && w.RTCPeerConnection
      },
      worker: async () => {
        const code = `postMessage(typeof self.RTCPeerConnection)`
        const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
        const t = await new Promise((res) => {
          w.onmessage = (e) => res(e.data)
          w.onerror = (e) => res(`error ${e.message || 'event'}`)
          setTimeout(() => res('no reply'), 1500)
        })
        R.workerType = t
        return undefined
      },
    }
    for (const [route, get] of Object.entries(ctors)) {
      const r = (R.routes[route] = {})
      let ctor
      try {
        ctor = await Promise.race([get(), wait(3000).then(() => 'timeout')])
        r.ctor = str(ctor)
      } catch (e) {
        r.ctor = err(e)
      }
      if (typeof ctor !== 'function') continue
      r.offer = await settle(async () => {
        const pc = new ctor({ iceServers: [{ urls: `stun:127.0.0.1:${cfg.stun[route]}` }] })
        pc.createDataChannel('x')
        r.candidates = 0
        pc.onicecandidate = (e) => e.candidate && r.candidates++
        await pc.setLocalDescription(await pc.createOffer())
        return 'local description set'
      }, 3000)
    }
    await wait(3000)
    R.violations = violations.slice(0, 30)
    await send('done', R)
  }

  async function ipc() {
    const R = { identity, sent: {} }
    const keys = { none: `fixture-key-${tag}`, leaked: cfg.leakedKey }
    let cbn = 3200000000 + 1000 * Math.floor(Math.random() * 1000)
    const token = (route, km) => `${tag}.${route}.${km}`
    const raw = (km, t, payload) => JSON.stringify({ cmd: 'probe_mark', callback: cbn++, error: cbn++, payload, options: {}, __TAURI_INVOKE_KEY__: keys[km] })
    const endpoints = { 'pm-ipc': () => window.ipc, 'pm-webkit': () => window.webkit.messageHandlers.ipc, 'pm-chrome': () => window.chrome.webview }
    for (const [route, get] of Object.entries(endpoints)) {
      const ep = attempt(get)
      for (const km of ['none', 'leaked']) {
        const t = token(route, km)
        if (!ep.ok || ep.value !== 'object') {
          R.sent[t] = { skipped: ep.ok ? ep.value : ep.error }
          continue
        }
        R.sent[t] = attempt(() => (get().postMessage(raw(km, t, { token: t })), 'sent'))
        const te = token(`${route}-enc`, km)
        const fake = { nonce: Array(12).fill(1), payload: Array(48).fill(2), contentType: 'application/json' }
        R.sent[te] = attempt(() => (get().postMessage(raw(km, te, fake)), 'sent'))
      }
    }
    const own = attempt(() => window.__TAURI_INTERNALS__.invoke)
    R.sent[token('internals', 'own')] = own.ok && own.value === 'function' ? await settle(() => window.__TAURI_INTERNALS__.invoke('probe_mark', { token: token('internals', 'own') }), 5000) : { skipped: own.ok ? own.value : own.error }
    const par = attempt(() => parent.__TAURI_INTERNALS__.invoke)
    R.sent[token('parent-internals', 'own')] = par.ok && par.value === 'function' ? await settle(() => parent.__TAURI_INTERNALS__.invoke('probe_mark', { token: token('parent-internals', 'own') }), 5000) : { skipped: par.ok ? par.value : par.error }
    R.parentFrames = attempt(() => parent.frames.length)
    R.oracle = []
    try {
      for (let i = 0; i < parent.frames.length; i++) {
        const t = token(`oracle-${i}`, 'own')
        R.oracle.push(attempt(() => (parent.frames[i].postMessage({ cmd: 'probe_mark', callback: cbn++, error: cbn++, payload: { token: t }, options: {} }, '*'), 'posted')))
      }
    } catch (e) {
      R.oracle.push({ ok: false, error: err(e) })
    }
    R.pattern = attempt(() => JSON.stringify(window.__TAURI_INTERNALS__.__TAURI_PATTERN__))
    await wait(2500)
    await send('done', R)
  }

  async function assets() {
    const R = { identity, own: {}, foreign: {} }
    const load = (base, kind) =>
      new Promise((resolve) => {
        const done = (v) => resolve(v)
        setTimeout(() => done('no result in 2500 ms'), 2500)
        try {
          if (kind === 'module') {
            const s = document.createElement('script')
            s.type = 'module'
            s.src = base('mod.js')
            s.onload = () => done(`load, ran ${str(globalThis.__probeModule)}`)
            s.onerror = () => done('error')
            document.body.appendChild(s)
          } else if (kind === 'style') {
            const l = document.createElement('link')
            l.rel = 'stylesheet'
            l.href = base('style.css')
            l.onload = () => done(`load, width ${getComputedStyle(document.getElementById('probe-style')).width}`)
            l.onerror = () => done('error')
            document.head.appendChild(l)
          } else if (kind === 'image') {
            const i = new Image()
            i.onload = () => done(`load, ${i.naturalWidth}x${i.naturalHeight}`)
            i.onerror = () => done('error')
            i.src = base('img.png')
            document.body.appendChild(i)
          } else {
            const w = new Worker(base('worker.js'))
            w.onmessage = (e) => done(`message ${str(e.data)}`)
            w.onerror = () => done('error event')
          }
        } catch (e) {
          done(err(e))
        }
      })
    for (const kind of ['module', 'style', 'image', 'worker']) {
      R.own[kind] = await load((f) => `${cfg.ownBase}asset/${f}`, kind)
      R.foreign[kind] = await load(() => sink(`asset-${kind}`), kind)
    }
    await wait(1000)
    R.violations = violations.slice(0, 30)
    await send('done', R)
  }

  async function storage() {
    const phase = cfg.phase
    const me = cfg.app
    const sib = cfg.sibling
    const value = `STORE-${me}-${cfg.variant}`
    const idb = (name, write) =>
      new Promise((resolve) => {
        try {
          let created = false
          const rq = indexedDB.open(name)
          rq.onupgradeneeded = () => {
            created = true
            if (write) rq.result.createObjectStore('kv')
          }
          rq.onerror = () => resolve({ ok: false, error: err(rq.error) })
          rq.onsuccess = () => {
            const db = rq.result
            if (!db.objectStoreNames.contains('kv')) {
              db.close()
              if (created) indexedDB.deleteDatabase(name)
              return resolve({ ok: true, value: 'absent' })
            }
            const tx = db.transaction('kv', write ? 'readwrite' : 'readonly')
            const op = write ? tx.objectStore('kv').put(write, 'v') : tx.objectStore('kv').get('v')
            op.onsuccess = () => resolve({ ok: true, value: write ? 'wrote' : str(op.result) })
            op.onerror = () => resolve({ ok: false, error: err(op.error) })
            tx.oncomplete = () => db.close()
          }
        } catch (e) {
          resolve({ ok: false, error: err(e) })
        }
      })
    const R = { identity, phase }
    if (phase === 'write') {
      R.write = {
        localStorage: attempt(() => (localStorage.setItem(`own_${me}`, value), 'wrote')),
        cookie: attempt(() => ((document.cookie = `ck_${me}=${value}; path=/; max-age=86400`), 'wrote')),
        idb: await idb(`db_${me}`, value),
      }
    }
    R.read = {
      own: attempt(() => localStorage.getItem(`own_${me}`)),
      sibling: attempt(() => localStorage.getItem(`own_${sib}`)),
      host: attempt(() => localStorage.getItem('host_secret')),
      keys: attempt(() => Object.keys(localStorage).sort().join(',')),
      cookie: attempt(() => document.cookie),
      idbOwn: await idb(`db_${me}`),
      idbSibling: await idb(`db_${sib}`),
      idbHost: await idb('hostdb'),
      idbNames: await settle(async () => (await indexedDB.databases()).map((d) => d.name).sort().join(','), 2000),
    }
    await send(`done-${phase}`, R)
  }

  const bridgeCalls = () => {
    let id = 0
    const waiting = new Map()
    const events = []
    addEventListener('message', (e) => {
      const d = e.data
      if (e.source !== parent || !d) return
      if ('bres' in d) {
        const w = waiting.get(d.bres)
        waiting.delete(d.bres)
        if (w) w(d)
      } else if (d.bevent) events.push({ ev: d.bevent, atMs: d.atMs, gotMs: Date.now() })
      else if ('bhost' in d) request({ op: 'hostreply', id: d.bhost, tag: 'hostreply' }, 5000)
    })
    const request = (body, ms = 30000) =>
      new Promise((resolve) => {
        const k = ++id
        const t0 = performance.now()
        waiting.set(k, (d) => resolve({ reply: d.reply, error: d.error, ms: performance.now() - t0 }))
        parent.postMessage({ probe: 1, app: cfg.app, kind: 'breq', id: k, body, ms }, '*')
        setTimeout(() => waiting.delete(k) && resolve({ error: `no reply in ${ms + 2000} ms`, ms: ms + 2000 }), ms + 2000)
      })
    return { request, events }
  }

  async function nested() {
    const body = (tag) => ({ op: 'ping', tag, app: cfg.sibling, origin: cfg.ownBase })
    const r = {
      grandparent: attempt(() => (parent.parent.postMessage({ probe: 1, app: cfg.sibling, kind: 'breq', id: 9001, body: body('nested-grandparent') }, '*'), 'posted')),
      top: attempt(() => (top.postMessage({ probe: 1, app: cfg.sibling, kind: 'breq', id: 9002, body: body('nested-top') }, '*'), 'posted')),
      report: attempt(() => (top.postMessage({ probe: 1, app: cfg.app, kind: 'done', data: { forgedReport: true } }, '*'), 'posted')),
    }
    parent.postMessage({ nested: r }, '*')
  }

  async function bridge() {
    const { request, events } = bridgeCalls()
    const R = { identity, rt: { ok: 0, failed: 0, ownIdentity: 0, otherIdentity: 0, ms: [], errors: [] } }
    let streak = 0
    for (let i = 0; i < 100 && streak < 3; i++) {
      const claim = i % 2 === 1
      const r = await request({ op: 'ping', tag: 'rt', n: i, ...(claim ? { app: cfg.sibling, origin: cfg.ownBase.replace(/appa|appb/, (m) => (m === 'appa' ? 'appb' : 'appa')) } : {}) }, 5000)
      if (r.reply && r.reply.n === i) {
        streak = 0
        R.rt.ok++
        R.rt.ms.push(Math.round(r.ms * 10) / 10)
        if (r.reply.app === cfg.app) R.rt.ownIdentity++
        else R.rt.otherIdentity++
      } else {
        streak++
        R.rt.failed++
        if (R.rt.errors.length < 5) R.rt.errors.push(r.error || str(JSON.stringify(r.reply)))
      }
    }
    await send('rt-done', { ok: R.rt.ok })
    const until = Date.now() + 20000
    while (!events.length && Date.now() < until) await wait(50)
    R.event = events.length ? { count: events.length, latencyMs: events[0].gotMs - events[0].atMs, ev: events[0].ev } : { count: 0, waitedMs: 20000 }
    R.size = {}
    for (const n of [1024, 65536, 1048576]) {
      if (!R.rt.ok) {
        R.size[n] = { skipped: 'no round trip succeeded' }
        continue
      }
      const r = await request({ op: 'size', tag: `size-${n}`, data: 'a'.repeat(n), replySize: n }, 30000)
      R.size[n] = r.reply ? { ok: r.reply.len === n && typeof r.reply.data === 'string' && r.reply.data.length === n, requestLen: r.reply.len, replyLen: r.reply.data && r.reply.data.length, ms: Math.round(r.ms) } : { ok: false, error: r.error, ms: Math.round(r.ms) }
    }
    const direct = (R.direct = {})
    const bridgeUrl = `${cfg.ownBase}bridge`
    direct.fetch = await settle(async () => {
      const res = await fetch(bridgeUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ op: 'ping', tag: 'direct-fetch' }) })
      return `status ${res.status} ${(await res.text()).slice(0, 80)}`
    }, 4000)
    direct.fetchNoCors = await settle(async () => {
      const res = await fetch(bridgeUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ op: 'ping', tag: 'direct-fetch-nocors' }) })
      return `type ${res.type}`
    }, 4000)
    direct.beacon = attempt(() => navigator.sendBeacon(bridgeUrl, JSON.stringify({ op: 'ping', tag: 'direct-beacon' })))
    direct.ownInternals = attempt(() => window.__TAURI_INTERNALS__.invoke)
    const par = attempt(() => parent.__TAURI_INTERNALS__.invoke)
    direct.parentInternals = par.ok && par.value === 'function' ? await settle(() => parent.__TAURI_INTERNALS__.invoke('bridge_call', { body: { op: 'ping', tag: 'direct-parent-internals' } }), 5000) : par
    const keys = { none: `fixture-key-${tag}`, leaked: cfg.leakedKey }
    let cbn = 3300000000 + 1000 * Math.floor(Math.random() * 1000)
    const raw = (km) => JSON.stringify({ cmd: 'bridge_call', callback: cbn++, error: cbn++, payload: { body: { op: 'ping', tag: `direct-ipc-${km}` } }, options: {}, __TAURI_INVOKE_KEY__: keys[km] })
    const endpoints = { webkit: () => window.webkit.messageHandlers.ipc, chrome: () => window.chrome.webview, ipc: () => window.ipc }
    for (const [name, get] of Object.entries(endpoints)) {
      for (const km of ['none', 'leaked']) {
        const ep = attempt(get)
        direct[`${name}-${km}`] = ep.ok && ep.value === 'object' ? attempt(() => (get().postMessage(raw(km)), 'sent')) : { skipped: ep.ok ? ep.value : ep.error }
      }
    }
    const brq = `BRQ|900|0|1|${btoa(JSON.stringify({ op: 'ping', tag: 'direct-title' }))}`
    direct.parentTitle = attempt(() => ((parent.document.title = brq), 'wrote'))
    direct.ownTitle = attempt(() => ((document.title = brq), 'wrote'))
    direct.topLocation = attempt(() => ((top.location.href = `${cfg.ownBase}wrap.html?r=direct-top`), 'assigned'))
    await wait(1500)
    const relay = (R.relay = {})
    const nestedReply = new Promise((resolve) => {
      addEventListener('message', (e) => e.data && e.data.nested && resolve(e.data.nested))
      setTimeout(() => resolve('no reply in 4000 ms'), 4000)
    })
    const html = document.documentElement.outerHTML.replace('"mode":"frame"', '"mode":"nested"')
    relay.nestedFrame = await settle(async () => {
      const f = await childFrame((el) => (el.srcdoc = html))
      return f ? `frame ${str(f.src || 'srcdoc')}` : 'no frame'
    }, 3000)
    relay.nested = await nestedReply
    relay.popup = attempt(() => String(window.open(`${cfg.ownBase}wrap.html?r=popup`)))
    const forged = await request({ op: 'ping', tag: 'forged-origin', n: -1, app: cfg.sibling, origin: 'http://forged.example' }, 5000)
    relay.forgedField = forged.reply ? { replyApp: forged.reply.app, ownApp: cfg.app } : { error: forged.error }
    await wait(1500)
    R.violations = violations.slice(0, 30)
    await send('done', R)
  }

  async function hang() {
    if (cfg.bridge) bridgeCalls()
    let beat = 0
    setInterval(() => {
      beat++
      if (framed) parent.postMessage({ probe: 1, app: cfg.app, kind: 'hb' }, '*')
      else document.title = `HB|${cfg.app}|${beat}`
    }, 100)
    window.__probeHang = () => {
      for (;;) {}
    }
    if (framed) {
      addEventListener('message', (e) => {
        if (e.data && e.data.probeHang) window.__probeHang()
      })
    }
    await send('ready', { identity })
  }

  async function nav() {
    const route = cfg.route
    document.title = `NAV|${route}`
    if (route === 'none') {
      await send('navready-none', { identity })
      return
    }
    if (framed) {
      addEventListener('message', (e) => {
        if (e.data && e.data.probePing) parent.postMessage({ probe: 1, app: cfg.app, kind: 'pong', data: { route, href: str(location.href) } }, '*')
      })
    }
    await wait(300)
    const dns = route.endsWith('-dns')
    const kind = dns ? route.slice(0, -4) : route
    const base = dns ? cfg.sink.replace('127.0.0.1', `${kind}-${cfg.variant.toLowerCase()}.wp.test`) : cfg.sink
    const u = `${base}/e/${cfg.variant}/${cfg.app}/nav-${route}`
    const form = (target) => {
      const f = document.createElement('form')
      f.method = 'post'
      f.action = u
      f.target = target
      const i = document.createElement('input')
      i.name = 'x'
      i.value = '1'
      f.appendChild(i)
      document.body.appendChild(f)
      f.submit()
    }
    const click = (download) => {
      const a = document.createElement('a')
      a.href = u
      if (download) a.download = 'x.txt'
      a.textContent = 'go'
      document.body.appendChild(a)
      a.click()
    }
    const routes = {
      topnav: () => (top.location.href = u),
      assign: () => location.assign(u),
      replace: () => location.replace(u),
      'form-top': () => form('_top'),
      'form-parent': () => form('_parent'),
      nested: () => {
        const f = document.createElement('iframe')
        f.src = u
        document.body.appendChild(f)
      },
      link: () => click(false),
      'form-self': () => form('_self'),
      'form-blank': () => form('_blank'),
      meta: () => {
        const m = document.createElement('meta')
        m.httpEquiv = 'refresh'
        m.content = `0;url=${u}`
        document.head.appendChild(m)
      },
      open: () => window.open(u),
      download: () => click(true),
    }
    const r = attempt(routes[kind])
    document.title = `NAV|${route}|${r.ok ? 'ok' : r.error}`
  }

  const groups = { Rtc: rtc, Ipc: ipc, Assets: assets, Storage: storage, Hang: hang, Nav: nav, Bridge: bridge }
  if (cfg.mode === 'nested') return nested()
  try {
    await groups[cfg.group]()
  } catch (e) {
    await send('done', { fatal: err(e) })
  }
})()
