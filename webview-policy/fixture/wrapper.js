;(async function wrapper() {
  const cfg = JSON.parse(document.getElementById('probe-cfg').textContent)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let queue = Promise.resolve()
  const send = (app, kind, data) => {
    queue = queue.then(async () => {
      const s = btoa(unescape(encodeURIComponent(JSON.stringify(data))))
      const n = Math.ceil(s.length / 900) || 1
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < n; i++) {
          document.title = `PROBE|${app}|${kind}|${i}|${n}|${s.slice(i * 900, (i + 1) * 900)}`
          await wait(120)
        }
      }
    })
    return queue
  }
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', cfg.sandbox)
  frame.srcdoc = cfg.srcdoc
  let loads = 0
  let pong = null
  frame.addEventListener('load', () => loads++)
  addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.probe !== 1 || e.source !== frame.contentWindow) return
    if (d.kind === 'hb') {
      document.title = `HB|${d.app}|${Date.now()}`
      return
    }
    if (d.kind === 'pong') {
      pong = d.data
      return
    }
    send(d.app, d.kind, d.data)
  })
  window.__probeHang = () => frame.contentWindow.postMessage({ probeHang: 1 }, '*')
  document.body.appendChild(frame)
  if (cfg.group === 'Hang') {
    let beat = 0
    setInterval(() => (document.title = `HB|W|${++beat}`), 100)
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
