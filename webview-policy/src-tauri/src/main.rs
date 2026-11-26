#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod trace;

use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256, Sha384, Sha512};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    http,
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

static FIXTURE_JS: LazyLock<String> = LazyLock::new(|| include_str!("../../fixture/document.js").replace("\r\n", "\n"));
static WRAPPER_JS: LazyLock<String> = LazyLock::new(|| include_str!("../../fixture/wrapper.js").replace("\r\n", "\n"));
const DEADLINE: Duration = Duration::from_secs(300);
const WEBRTC_ROUTES: [&str; 7] = ["direct", "saved", "webkit", "blank", "srcdoc", "open", "worker"];
const NAV_ROUTES: [&str; 8] = ["topnav", "assign", "link", "form-self", "form-blank", "meta", "open", "download"];
const NAV2_ROUTES: [&str; 14] = [
    "assign", "replace", "link", "form-self", "form-blank", "form-top", "form-parent", "meta", "open", "download", "nested", "assign-dns", "link-dns", "nested-dns",
];
const DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
const HOST_RULES: &str = r#"--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE *.localhost""#;
const FEATURE_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,LoadingPredictorUseLocalPredictions,LoadingPredictorUseOptimizationGuide,NavigationPredictor,PreconnectManagerDirectFastPath,SearchEnginePreconnect2,SpeculativeServiceWorkerWarmUp --autoplay-policy=no-user-gesture-required";
const WEBRTC_ARG: &str = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const UNTHROTTLE_ARGS: &str = "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
const STYLE_SOURCES: &str = "style-src 'unsafe-inline'; img-src data:";
const PNG_DATA: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGP4z8DwH4YZYBwAeuoJ9xhXr8AAAAAASUVORK5CYII=";
const DOCS_INIT: &str = r#"(() => {
  if (location.href !== 'about:srcdoc') return
  const violations = []
  const errors = []
  document.addEventListener('securitypolicyviolation', (e) => violations.push({ directive: e.effectiveDirective, uri: String(e.blockedURI).slice(0, 100), sample: String(e.sample || '').slice(0, 60), line: e.lineNumber }))
  addEventListener('error', (e) => errors.push(String(e.message || (e.target && e.target.tagName) || 'error').slice(0, 200)), true)
  addEventListener('unhandledrejection', (e) => errors.push(`rejection ${String((e.reason && e.reason.message) || e.reason).slice(0, 200)}`))
  const report = () => {
    const vw = innerWidth
    const vh = innerHeight
    const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw
    let boxes = 0
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      const cs = getComputedStyle(el)
      if (cs.visibility !== 'hidden' && cs.display !== 'none' && inView(el.getBoundingClientRect())) boxes++
    }
    let text = 0
    const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim()
      if (!t) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      if ([...range.getClientRects()].some(inView)) text += t.length
    }
    const sheets = [...document.styleSheets].map((sh) => { try { return sh.cssRules.length } catch (e) { return -1 } })
    const scripts = [...document.scripts].map((sc) => ({ src: sc.src ? 'external' : 'inline', type: sc.type || 'classic' }))
    const byDirective = {}
    for (const v of violations) byDirective[v.directive] = (byDirective[v.directive] || 0) + 1
    const headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => h.textContent.trim().slice(0, 60))
    parent.postMessage({ probe: 1, app: 'A', kind: 'done', data: { viewport: [vw, vh], boxes, text, sheets, scripts, byDirective, violations: violations.slice(0, 30), errors: errors.slice(0, 20), headings: headings.slice(0, 6), background: document.body ? getComputedStyle(document.body).backgroundColor : null, scrollHeight: document.documentElement.scrollHeight, hostCalls: window.__hostCalls || null, loaded: window.__probeLoaded, sample: document.body ? document.body.innerText.slice(0, 200) : '' } }, '*')
  }
  let loaded = false
  addEventListener('load', () => (loaded = true))
  addEventListener('message', (e) => e.source === parent && e.data && e.data.probeDocsReport && ((window.__probeLoaded = loaded), report()))
})()"#;
const INIT_SCRIPT: &str = r#"(() => {
  const names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport', 'RTCCertificate', 'RTCPeerConnectionIceEvent', 'RTCDataChannelEvent', 'RTCTrackEvent', 'RTCError', 'RTCErrorEvent', 'RTCStatsReport', 'RTCDTMFSender', 'RTCEncodedAudioFrame', 'RTCEncodedVideoFrame', 'RTCRtpScriptTransform']
  for (const n of names) {
    try { Object.defineProperty(globalThis, n, { value: undefined, writable: false, configurable: false, enumerable: false }) } catch (e) {}
  }
  try { Object.defineProperty(globalThis, '__probeInit', { value: String(location.href), writable: false, configurable: false }) } catch (e) {}
})()"#;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Group {
    Rtc,
    Nav,
    Ipc,
    Assets,
    Storage,
    Hang,
    Bridge,
    Style,
    Hashes,
    Surface,
    Memory,
    Docs,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Surface {
    Visible,
    Hidden,
    Zero,
    Offscreen,
    HiddenChild,
}

#[derive(Clone, Copy, PartialEq)]
enum Layout {
    Frames,
    Windows,
    Children,
}

#[derive(Clone, Copy, PartialEq)]
enum Policy {
    Base,
    WebrtcBlock,
    Assets,
    Off,
}

#[derive(Clone, Copy, PartialEq)]
enum Args {
    Stock,
    Hosts,
    Proxy,
    Both,
    Features,
}

fn csp_hash(alg: &str, text: &str) -> String {
    let b = text.as_bytes();
    let digest = match alg {
        "sha384" => Sha384::digest(b).to_vec(),
        "sha512" => Sha512::digest(b).to_vec(),
        _ => Sha256::digest(b).to_vec(),
    };
    format!("{alg}-{}", base64::engine::general_purpose::STANDARD.encode(digest))
}

fn inline_scripts(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = vec![];
    let mut at = 0;
    while let Some(start) = lower[at..].find("<script").map(|i| i + at) {
        let Some(tag_end) = lower[start..].find('>').map(|i| i + start + 1) else { break };
        let Some(close) = lower[tag_end..].find("</script").map(|i| i + tag_end) else { break };
        let attrs = &lower[start + 7..tag_end - 1];
        let ty = attrs.split("type=").nth(1).map(|t| t.trim_start_matches(['"', '\'']).split(['"', '\'', ' ']).next().unwrap_or("").to_owned());
        let executes = ty.as_deref().is_none_or(|t| t.is_empty() || t == "module" || t.contains("javascript") || t.contains("ecmascript"));
        if executes && !attrs.contains("src=") {
            out.push(html[tag_end..close].replace("\r\n", "\n").replace('\r', "\n"));
        }
        at = close + 8;
    }
    out
}

fn after_head(html: &str) -> usize {
    let lower = html.to_ascii_lowercase();
    if let Some(h) = lower.find("<head") {
        if let Some(e) = lower[h..].find('>') {
            return h + e + 1;
        }
    }
    if lower.trim_start().starts_with("<!doctype") {
        return lower.find('>').map(|e| e + 1).unwrap_or(0);
    }
    0
}

const HASH_SCRIPTS: [(&str, &str, &str); 8] = [
    ("s1-sha256", "sha256", "window.__ran=window.__ran||[];__ran.push('s1-sha256')"),
    ("s2-sha384", "sha384", "window.__ran=window.__ran||[];__ran.push('s2-sha384')"),
    ("s3-sha512", "sha512", "window.__ran=window.__ran||[];__ran.push('s3-sha512')"),
    ("s4-unhashed", "none", "window.__ran=window.__ran||[];__ran.push('s4-unhashed')"),
    ("s5-crlf-raw", "raw", "window.__ran=window.__ran||[];\r\n__ran.push('s5-crlf-raw')"),
    ("s6-crlf-lf", "lf", "window.__ran=window.__ran||[];\r\n__ran.push('s6-crlf-lf')"),
    ("s7-trimmed", "trim", "\n  window.__ran=window.__ran||[];__ran.push('s7-trimmed')  \n"),
    ("s8-utf8", "sha256", "window.__ran=window.__ran||[];__ran.push('s8-utf8-\u{e9}')"),
];

fn hash_markup() -> (String, Vec<String>) {
    let mut html = String::new();
    let mut hashes = vec![];
    for (_, alg, text) in HASH_SCRIPTS {
        html.push_str(&format!("<script>{text}</script>"));
        match alg {
            "none" => {}
            "raw" => hashes.push(csp_hash("sha256", text)),
            "lf" => hashes.push(csp_hash("sha256", &text.replace("\r\n", "\n"))),
            "trim" => hashes.push(csp_hash("sha256", text.trim())),
            a => hashes.push(csp_hash(a, text)),
        }
    }
    html.push_str(r#"<button id="hash-onclick" onclick="window.__ran=window.__ran||[];__ran.push('onclick')">x</button>"#);
    (html, hashes)
}

#[derive(Clone, Copy, PartialEq)]
enum Source {
    Srcdoc,
    Scheme,
}

struct Frame {
    app: &'static str,
    sandbox: &'static str,
    source: Source,
}

struct App {
    app: &'static str,
    label: &'static str,
    scheme_app: &'static str,
}

struct Spec {
    group: Group,
    layout: Layout,
    frames: Vec<Frame>,
    apps: Vec<App>,
    policy: Policy,
    init_all_frames: bool,
    webrtc_arg: bool,
    no_peer: bool,
    nav_guard: bool,
    host_hang: bool,
    wrap: bool,
    frame_src_open: bool,
    frame_sandbox: &'static str,
    args: Args,
    frame_cancel: bool,
    bridge: Option<char>,
    surface: Surface,
    unthrottle: bool,
    style_policy: bool,
    host_hidden: bool,
    hold_activity: bool,
}

fn spec(name: &str) -> Spec {
    let base = |group, layout| Spec {
        group,
        layout,
        frames: vec![],
        apps: vec![],
        policy: Policy::Base,
        init_all_frames: false,
        webrtc_arg: false,
        no_peer: false,
        nav_guard: false,
        host_hang: false,
        wrap: false,
        frame_src_open: false,
        frame_sandbox: "allow-scripts",
        args: Args::Stock,
        frame_cancel: false,
        bridge: None,
        surface: Surface::Visible,
        unthrottle: false,
        style_policy: false,
        host_hidden: false,
        hold_activity: false,
    };
    let srcdoc = |app| Frame { app, sandbox: "allow-scripts", source: Source::Srcdoc };
    let scheme = |app| Frame { app, sandbox: "allow-scripts", source: Source::Scheme };
    let win = |app, label| App { app, label, scheme_app: app };
    let frames = |group, f: Vec<Frame>| Spec { frames: f, ..base(group, Layout::Frames) };
    let windows = |group, a: Vec<App>| Spec { apps: a, ..base(group, Layout::Windows) };
    let children = |group, a: Vec<App>| Spec { apps: a, ..base(group, Layout::Children) };
    let w2 = |group, layout, a: Vec<App>| Spec { apps: a, wrap: true, init_all_frames: true, nav_guard: true, ..base(group, layout) };
    let b3 = |group, layout, c: char, two: bool| {
        let (a, b) = match c {
            'S' => ("bs-a", "bs-b"),
            'C' => ("bc-a", "bc-b"),
            _ => ("bt-a", "bt-b"),
        };
        let apps = if two { vec![win("A", a), win("B", b)] } else { vec![win("A", a)] };
        Spec { bridge: Some(c), args: Args::Hosts, ..w2(group, layout, apps) }
    };
    let labels = |c: char| match c {
        'S' => "bs-a",
        'C' => "bc-a",
        _ => "bt-a",
    };
    match name {
        "Y3C" | "Y3W" | "Y3CH" | "Y3WH" | "Z3C" | "Z3W" => {
            let layout = if name.as_bytes()[2] == b'W' { Layout::Windows } else { Layout::Children };
            let group = if name.starts_with('Y') { Group::Style } else { Group::Hashes };
            let args = if name.ends_with('H') { Args::Hosts } else { Args::Stock };
            return Spec { style_policy: group == Group::Style, args, ..w2(group, layout, vec![win("A", "app-a")]) };
        }
        "M3V" | "M3H" | "M3C" | "M3Z" => {
            let layout = if matches!(name, "M3V" | "M3H") { Layout::Windows } else { Layout::Children };
            let surface = match name {
                "M3H" => Surface::Hidden,
                "M3Z" => Surface::Zero,
                _ => Surface::Visible,
            };
            let apps = ["m1-a", "m2-a", "m3-a", "m4-a"].into_iter().map(|l| win("A", l)).collect();
            return Spec { surface, ..w2(Group::Memory, layout, apps) };
        }
        _ => {}
    }
    if let [b'V', b'3', c, m] = name.as_bytes() {
        let c = *c as char;
        let (layout, surface, unthrottle) = match m {
            b'V' => (Layout::Windows, Surface::Visible, false),
            b'H' | b'N' => (Layout::Windows, Surface::Hidden, false),
            b'X' | b'A' => (Layout::Windows, Surface::Hidden, true),
            b'C' => (Layout::Children, Surface::Visible, false),
            b'Z' => (Layout::Children, Surface::Zero, false),
            b'O' => (Layout::Children, Surface::Offscreen, false),
            _ => (Layout::Children, Surface::HiddenChild, false),
        };
        let all_hidden = matches!(m, b'N' | b'A');
        return Spec { bridge: Some(c), surface, unthrottle, host_hidden: all_hidden, hold_activity: *m == b'A', ..w2(Group::Surface, layout, vec![win("A", labels(c))]) };
    }
    if let [b'D', b'3', c] = name.as_bytes() {
        let c = *c as char;
        return Spec { bridge: Some(c), surface: Surface::Hidden, host_hidden: true, unthrottle: true, hold_activity: true, style_policy: true, ..w2(Group::Docs, Layout::Windows, vec![win("A", labels(c))]) };
    }
    if let [p0, p1, c, l] = name.as_bytes() {
        let layout = if *l == b'W' { Layout::Windows } else { Layout::Children };
        let c = *c as char;
        if *p1 == b'3' && matches!(c, 'S' | 'C' | 'T') && matches!(*l, b'C' | b'W') {
            match *p0 {
                b'B' | b'X' => return b3(Group::Bridge, layout, c, true),
                b'H' => return b3(Group::Hang, layout, c, true),
                b'N' => return b3(Group::Nav, layout, c, false),
                b'R' => return b3(Group::Rtc, layout, c, false),
                _ => {}
            }
        }
    }
    match name {
        "RF0" => frames(Group::Rtc, vec![srcdoc("A")]),
        "RF1" => Spec { policy: Policy::WebrtcBlock, ..frames(Group::Rtc, vec![srcdoc("A")]) },
        "RF2" => Spec { policy: Policy::WebrtcBlock, ..frames(Group::Rtc, vec![scheme("A")]) },
        "RF3" => Spec { init_all_frames: true, ..frames(Group::Rtc, vec![srcdoc("A")]) },
        "RF4" => Spec { webrtc_arg: true, ..frames(Group::Rtc, vec![srcdoc("A")]) },
        "RF5" => Spec { no_peer: true, ..frames(Group::Rtc, vec![srcdoc("A")]) },
        "RW0" => windows(Group::Rtc, vec![win("A", "app-a")]),
        "RW1" => Spec { policy: Policy::WebrtcBlock, ..windows(Group::Rtc, vec![win("A", "app-a")]) },
        "RW3" => Spec { init_all_frames: true, ..windows(Group::Rtc, vec![win("A", "app-a")]) },
        "RW4" => Spec { webrtc_arg: true, ..windows(Group::Rtc, vec![win("A", "app-a")]) },
        "RW5" => Spec { no_peer: true, ..windows(Group::Rtc, vec![win("A", "app-a")]) },
        "NW0" => windows(Group::Nav, vec![win("A", "app-a")]),
        "NW1" => Spec { nav_guard: true, ..windows(Group::Nav, vec![win("A", "app-a")]) },
        "NC0" => children(Group::Nav, vec![win("A", "app-a")]),
        "NC1" => Spec { nav_guard: true, ..children(Group::Nav, vec![win("A", "app-a")]) },
        "KF1" | "XF1" => frames(Group::Ipc, vec![srcdoc("A")]),
        "KF2" | "XF2" => frames(Group::Ipc, vec![scheme("A")]),
        "KFC" | "XFC" => frames(Group::Ipc, vec![Frame { app: "A", sandbox: "allow-scripts allow-same-origin", source: Source::Srcdoc }]),
        "PF" => Spec { policy: Policy::Assets, ..frames(Group::Assets, vec![scheme("A")]) },
        "PW" => Spec { policy: Policy::Assets, ..windows(Group::Assets, vec![win("A", "app-a")]) },
        "PWn" => Spec { policy: Policy::Off, ..windows(Group::Assets, vec![win("A", "app-a")]) },
        "SW" => windows(Group::Storage, vec![win("A", "app-a"), win("B", "app-b")]),
        "SC" => children(Group::Storage, vec![win("A", "app-a"), win("B", "app-b")]),
        "SX" => windows(Group::Storage, vec![win("A", "app-a"), App { app: "B", label: "app-b", scheme_app: "A" }]),
        "HF1" => frames(Group::Hang, vec![srcdoc("A")]),
        "HF2" => frames(Group::Hang, vec![scheme("A")]),
        "HW" => windows(Group::Hang, vec![win("A", "app-a")]),
        "HC" => children(Group::Hang, vec![win("A", "app-a")]),
        "HX" => Spec { host_hang: true, ..base(Group::Hang, Layout::Frames) },
        "N2C" => w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]),
        "N2W" => w2(Group::Nav, Layout::Windows, vec![win("A", "app-a")]),
        "N2CH" => Spec { args: Args::Hosts, ..w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]) },
        "N2WH" => Spec { args: Args::Hosts, ..w2(Group::Nav, Layout::Windows, vec![win("A", "app-a")]) },
        "N2CP" => Spec { args: Args::Proxy, ..w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]) },
        "N2WP" => Spec { args: Args::Proxy, ..w2(Group::Nav, Layout::Windows, vec![win("A", "app-a")]) },
        "N2CB" => Spec { args: Args::Both, ..w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]) },
        "N2WB" => Spec { args: Args::Both, ..w2(Group::Nav, Layout::Windows, vec![win("A", "app-a")]) },
        "N2CF" => Spec { args: Args::Features, ..w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]) },
        "N2WF" => Spec { args: Args::Features, ..w2(Group::Nav, Layout::Windows, vec![win("A", "app-a")]) },
        "N2CN" => Spec { frame_cancel: true, ..w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]) },
        "N2WN" => Spec { frame_cancel: true, ..w2(Group::Nav, Layout::Windows, vec![win("A", "app-a")]) },
        "R2CH" => Spec { args: Args::Hosts, ..w2(Group::Rtc, Layout::Children, vec![win("A", "app-a")]) },
        "R2CP" => Spec { args: Args::Proxy, ..w2(Group::Rtc, Layout::Children, vec![win("A", "app-a")]) },
        "R2CB" => Spec { args: Args::Both, ..w2(Group::Rtc, Layout::Children, vec![win("A", "app-a")]) },
        "R2CF" => Spec { args: Args::Features, ..w2(Group::Rtc, Layout::Children, vec![win("A", "app-a")]) },
        "R2CN" => Spec { frame_cancel: true, ..w2(Group::Rtc, Layout::Children, vec![win("A", "app-a")]) },
        "N2CC" => Spec { frame_src_open: true, ..w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]) },
        "N2CO" => Spec { frame_src_open: true, nav_guard: false, ..w2(Group::Nav, Layout::Children, vec![win("A", "app-a")]) },
        "N2WO" => Spec { frame_src_open: true, nav_guard: false, ..w2(Group::Nav, Layout::Windows, vec![win("A", "app-a")]) },
        "R2C0" => Spec { init_all_frames: false, ..w2(Group::Rtc, Layout::Children, vec![win("A", "app-a")]) },
        "R2C1" => w2(Group::Rtc, Layout::Children, vec![win("A", "app-a")]),
        "R2W0" => Spec { init_all_frames: false, ..w2(Group::Rtc, Layout::Windows, vec![win("A", "app-a")]) },
        "R2W1" => w2(Group::Rtc, Layout::Windows, vec![win("A", "app-a")]),
        "H2C" => w2(Group::Hang, Layout::Children, vec![win("A", "app-a")]),
        "H2W" => w2(Group::Hang, Layout::Windows, vec![win("A", "app-a")]),
        "K2C" | "X2C" => w2(Group::Ipc, Layout::Children, vec![win("A", "app-a")]),
        "K2W" | "X2W" => w2(Group::Ipc, Layout::Windows, vec![win("A", "app-a")]),
        "K2CC" | "X2CC" => Spec {
            frame_src_open: true,
            frame_sandbox: "allow-scripts allow-same-origin",
            ..w2(Group::Ipc, Layout::Children, vec![win("A", "ctl-a")])
        },
        "S2C" => w2(Group::Storage, Layout::Children, vec![win("A", "app-a"), win("B", "app-b")]),
        "S2W" => w2(Group::Storage, Layout::Windows, vec![win("A", "app-a"), win("B", "app-b")]),
        "S2X" => Spec {
            frame_sandbox: "allow-scripts allow-same-origin",
            ..w2(Group::Storage, Layout::Windows, vec![win("A", "app-a"), App { app: "B", label: "app-b", scheme_app: "A" }])
        },
        other => panic!("unknown PROBE_VARIANT {other}"),
    }
}

struct Probe {
    variant: String,
    launch: u32,
    dir: PathBuf,
    sink: String,
    stun: Map<String, Value>,
    nonce: String,
    hash: String,
    wrap_hash: String,
    started: Instant,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    config_served: bool,
    events: Map<String, Value>,
    chunks: HashMap<String, Vec<Option<String>>>,
    navigations: Vec<Value>,
    new_windows: Vec<Value>,
    downloads: Vec<Value>,
    heartbeats: Vec<u64>,
    host_replies: Vec<Value>,
    bridge_chunks: HashMap<String, Vec<Option<String>>>,
    doc_beats: HashMap<String, Vec<u64>>,
    loads: HashMap<String, u32>,
    destroyed: HashMap<String, u64>,
    notes: Map<String, Value>,
    written: bool,
}

impl Probe {
    fn ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn append(&self, file: &str, line: Value) {
        let mut f = OpenOptions::new().create(true).append(true).open(self.dir.join(file)).expect("open log");
        writeln!(f, "{line}").expect("write log");
    }

    fn event(&self, key: String, value: Value) {
        let ms = self.ms();
        let mut inner = self.inner.lock().unwrap();
        inner.events.entry(key).or_insert_with(|| json!({ "ms": ms, "data": value }));
    }

    fn has(&self, key: &str) -> bool {
        self.inner.lock().unwrap().events.contains_key(key)
    }

    fn note(&self, key: &str, value: Value) {
        self.inner.lock().unwrap().notes.insert(key.into(), value);
    }
}

fn scheme_of(app: &str) -> &'static str {
    if app == "A" { "appa" } else { "appb" }
}

fn own_base(app: &str) -> String {
    let scheme = scheme_of(app);
    if cfg!(windows) { format!("http://{scheme}.localhost/") } else { format!("{scheme}://localhost/") }
}

fn own_source(app: &str) -> String {
    let scheme = scheme_of(app);
    if cfg!(windows) { format!("http://{scheme}.localhost") } else { format!("{scheme}:") }
}

fn policy_text(policy: Policy, hash: &str, app: &str) -> Option<String> {
    let base = format!("default-src 'none'; script-src '{hash}'");
    match policy {
        Policy::Base => Some(base),
        Policy::WebrtcBlock => Some(format!("{base}; webrtc 'block'")),
        Policy::Assets => {
            let own = own_source(app);
            Some(format!("default-src 'none'; script-src '{hash}' {own}; style-src {own}; img-src {own}; worker-src {own}"))
        }
        Policy::Off => None,
    }
}

fn isolation_source(probe: &Probe) -> Option<String> {
    let inner = probe.inner.lock().unwrap();
    let src = inner.events.get("host.isolation")?["data"]["report"]["src"].as_str()?.to_owned();
    let url = tauri::Url::parse(&src).ok()?;
    Some(if cfg!(windows) { url.origin().ascii_serialization() } else { format!("{}:", url.scheme()) })
}

fn wrapper_policy(wrapper: &str, documents: &[String], open: bool, bridge: Option<char>, app: &str, style: bool, iso: Option<String>) -> String {
    let frames = match (open, bridge, iso) {
        (true, _, Some(i)) => format!("* {i}"),
        (true, _, None) => "* isolation: http://isolation.localhost".to_owned(),
        (false, Some('C'), Some(i)) => i,
        _ => "'none'".to_owned(),
    };
    let connect = if bridge == Some('S') { format!("; connect-src {}", own_origin(app)) } else { String::new() };
    let docs: String = documents.iter().map(|h| format!(" '{h}'")).collect();
    let styles = if style { format!("; {STYLE_SOURCES}") } else { String::new() };
    format!("default-src 'none'; script-src '{wrapper}'{docs}; frame-src {frames}; child-src {frames}{connect}{styles}")
}

fn wrapper_html(cfg: &Value, app: &str) -> String {
    let cfg = cfg.to_string().replace('<', "\\u003c");
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>wrapper {app}</title></head><body><script type="application/json" id="probe-cfg">{cfg}</script><script>{js}</script></body></html>"#,
        js = *WRAPPER_JS
    )
}

fn next_phase(probe: &Probe, fixture: &str) -> String {
    let mut inner = probe.inner.lock().unwrap();
    let n = inner.loads.entry(fixture.to_owned()).or_insert(0);
    *n += 1;
    match (probe.launch, *n) {
        (1, 1) => "write".to_owned(),
        (1, k) => format!("reload{}", k - 1),
        (l, k) => format!("launch{l}load{k}"),
    }
}

fn label_app(label: &str) -> Option<&'static str> {
    if label.ends_with("-a") {
        Some("A")
    } else if label.ends_with("-b") {
        Some("B")
    } else {
        None
    }
}

fn own_origin(app: &str) -> String {
    own_base(app).trim_end_matches('/').to_owned()
}

fn bridge_answer<R: Runtime>(app: &AppHandle<R>, label: &str, via: &str, origin: Option<String>, body: &Value) -> Value {
    let probe = app.state::<Probe>();
    let me = label_app(label).unwrap_or("none");
    let op = body["op"].as_str().unwrap_or("").to_owned();
    let len = body["data"].as_str().map(str::len).unwrap_or(0);
    probe.append(
        "bridge.log",
        json!({ "label": label, "app": me, "via": via, "origin": origin, "op": op, "tag": body["tag"], "claimApp": body["app"], "claimOrigin": body["origin"], "n": body["n"], "len": len, "ms": probe.ms() }),
    );
    match op.as_str() {
        "hostreply" => {
            let ms = probe.ms();
            probe.inner.lock().unwrap().host_replies.push(json!({ "label": label, "id": body["id"], "ms": ms }));
            json!({ "app": me, "op": op })
        }
        "hcall" => json!({ "app": me, "op": op, "result": fixture_forward(body) }),
        "size" => {
            let n = body["replySize"].as_u64().unwrap_or(0) as usize;
            json!({ "app": me, "op": op, "len": len, "data": "b".repeat(n) })
        }
        _ => json!({ "app": me, "op": op, "n": body["n"] }),
    }
}

fn fixture_forward(body: &Value) -> Value {
    use std::io::Read;
    let Ok(addr) = std::env::var("PROBE_FIXTURE_ADDR") else { return json!({ "error": "no fixture endpoint" }) };
    let payload = json!({ "method": body["method"], "args": body["args"] }).to_string();
    let attempt = || -> std::io::Result<Value> {
        let mut c = std::net::TcpStream::connect(&addr)?;
        write!(c, "POST /rpc HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len())?;
        let mut buf = String::new();
        c.read_to_string(&mut buf)?;
        let body = buf.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
        Ok(serde_json::from_str(body).unwrap_or_else(|_| json!({ "error": "bad fixture reply" })))
    };
    attempt().unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

#[tauri::command]
fn bridge_call(body: Value, webview: tauri::Webview) -> Value {
    let url = webview.url().ok().map(|u| u.to_string());
    bridge_answer(webview.app_handle(), webview.label(), "command", url, &body)
}

fn on_title_app<R: Runtime>(app: &AppHandle<R>, label: &str, title: &str) {
    let Some(rest) = title.strip_prefix("BRQ|") else {
        on_title(&app.state::<Probe>(), label, title);
        return;
    };
    let parts: Vec<&str> = rest.splitn(4, '|').collect();
    let [id, i, n, chunk] = parts.as_slice() else { return };
    let (Ok(id), Ok(i), Ok(n)) = (id.parse::<u64>(), i.parse::<usize>(), n.parse::<usize>()) else { return };
    let probe = app.state::<Probe>();
    let key = format!("{label}:{id}");
    let joined = {
        let mut inner = probe.inner.lock().unwrap();
        let slots = inner.bridge_chunks.entry(key.clone()).or_insert_with(|| vec![None; n]);
        if slots.len() != n || i >= n {
            return;
        }
        slots[i] = Some((*chunk).to_owned());
        if !slots.iter().all(Option::is_some) {
            return;
        }
        let joined: String = slots.iter().flatten().map(String::as_str).collect();
        inner.bridge_chunks.remove(&key);
        joined
    };
    let body = base64::engine::general_purpose::STANDARD
        .decode(joined)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(Value::Null);
    let reply = bridge_answer(app, label, "title", None, &body);
    if let Some(w) = app.get_webview(label) {
        let _ = w.eval(format!("window.__bridgeReply({id}, {reply})"));
    }
}

fn fixture_cfg<R: Runtime>(app: &AppHandle<R>, probe: &Probe, fixture: &str, mode: &str, extra: Value) -> Value {
    let s = spec(&probe.variant);
    let mut cfg = json!({
        "variant": probe.variant,
        "group": format!("{:?}", s.group),
        "launch": probe.launch,
        "app": fixture,
        "sibling": if fixture == "A" { "B" } else { "A" },
        "mode": mode,
        "sink": probe.sink,
        "stun": probe.stun,
        "nonce": probe.nonce,
        "leakedKey": app.invoke_key(),
        "ownBase": own_base(fixture),
        "exits": std::env::var("PROBE_EXITS").ok(),
    });
    if let (Value::Object(c), Value::Object(e)) = (&mut cfg, extra) {
        c.extend(e);
    }
    cfg
}

fn fixture_html(cfg: &Value, csp_meta: Option<&str>, fixture: &str) -> String {
    fixture_html_with(cfg, csp_meta, fixture, "")
}

fn style_markup() -> String {
    format!(r#"<style>#st-el{{width:37px;height:5px;background:rgb(1,2,3)}}</style><div id="st-el"></div><div id="st-attr" style="width:41px;height:5px"></div><img id="st-img" src="{PNG_DATA}">"#)
}

fn author_doc(fcfg: &Value) -> (String, Vec<String>) {
    let path = std::env::var("PROBE_DOC").expect("PROBE_DOC");
    let html = std::fs::read_to_string(path).expect("read document");
    let head = std::env::var("PROBE_DOC_HEAD").ok().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let head = head.replace("__PROBE_CFG__", &fcfg.to_string().replace('<', "\\u003c"));
    let at = after_head(&html);
    let body = format!("{}{head}{}", &html[..at], &html[at..]);
    let hashes: Vec<String> = inline_scripts(&body).iter().map(|t| csp_hash("sha256", t)).collect();
    let srcs: String = hashes.iter().map(|h| format!(" '{h}'")).collect();
    let meta = format!(r#"<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src{srcs}; {STYLE_SOURCES}">"#);
    let at = after_head(&body);
    (format!("{}{meta}{}", &body[..at], &body[at..]), hashes)
}

fn fixture_html_with(cfg: &Value, csp_meta: Option<&str>, fixture: &str, extra: &str) -> String {
    let cfg = cfg.to_string().replace('<', "\\u003c");
    let meta = csp_meta
        .map(|p| format!(r#"<meta http-equiv="Content-Security-Policy" content="{p}">"#))
        .unwrap_or_default();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">{meta}<title>fixture {fixture}</title></head><body><p id="fixture-secret">FIXTURE-{fixture}-SECRET</p><div id="probe-style"></div>{extra}<script type="application/json" id="probe-cfg">{cfg}</script><script>{js}</script></body></html>"#,
        js = *FIXTURE_JS
    )
}

#[tauri::command]
fn probe_mark(token: String, webview: tauri::Webview, request: tauri::ipc::Request<'_>, probe: State<'_, Probe>) -> String {
    mark(&probe, "probe_mark", token, &webview, &request)
}

fn mark<R: Runtime>(probe: &Probe, cmd: &str, token: String, webview: &tauri::Webview<R>, request: &tauri::ipc::Request<'_>) -> String {
    let header = |name: &str| request.headers().get(name).and_then(|h| h.to_str().ok()).map(str::to_owned);
    probe.append(
        "marker.log",
        json!({
            "cmd": cmd,
            "token": token,
            "webview": webview.label(),
            "window": webview.window().label(),
            "webviewUrl": webview.url().map(|u| u.to_string()).ok(),
            "origin": header("origin"),
            "ms": probe.ms(),
        }),
    );
    format!("marked {token}")
}

mod probe_plugin {
    use super::*;

    #[tauri::command]
    pub fn mark<R: Runtime>(token: String, webview: tauri::Webview<R>, request: tauri::ipc::Request<'_>, probe: State<'_, Probe>) -> String {
        super::mark(&probe, "plugin:probe|mark", token, &webview, &request)
    }

    pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
        tauri::plugin::Builder::new("probe").invoke_handler(tauri::generate_handler![mark]).build()
    }
}

#[tauri::command]
fn probe_config(app: AppHandle, probe: State<'_, Probe>) -> Value {
    probe.inner.lock().unwrap().config_served = true;
    let s = spec(&probe.variant);
    let frames: Vec<Value> = s
        .frames
        .iter()
        .map(|f| {
            let srcdoc = (f.source == Source::Srcdoc).then(|| {
                let policy = policy_text(s.policy, &probe.hash, f.app);
                fixture_html(&fixture_cfg(&app, &probe, f.app, "frame", json!({})), policy.as_deref(), f.app)
            });
            json!({ "app": f.app, "sandbox": f.sandbox, "srcdoc": srcdoc, "src": format!("{}index.html", own_base(f.app)) })
        })
        .collect();
    json!({
        "variant": probe.variant,
        "pattern": if cfg!(feature = "iso") { "isolation" } else { "brownfield" },
        "group": format!("{:?}", s.group),
        "launch": probe.launch,
        "nonce": probe.nonce,
        "frames": frames,
        "webviewVersion": tauri::webview_version().ok(),
    })
}

#[tauri::command]
fn probe_event(app: String, kind: String, data: Value, probe: State<'_, Probe>) {
    probe.event(format!("{app}.{kind}"), json!({ "via": "host", "report": data }));
}

#[tauri::command]
fn probe_heartbeat(source: Option<String>, probe: State<'_, Probe>) {
    let ms = probe.ms();
    let mut inner = probe.inner.lock().unwrap();
    match source {
        Some(s) => inner.doc_beats.entry(s).or_default().push(ms),
        None => inner.heartbeats.push(ms),
    }
}

#[tauri::command]
fn probe_report(report: Value, probe: State<'_, Probe>) {
    probe.event("host.report".into(), report);
}

fn on_title(probe: &Probe, label: &str, title: &str) {
    if let Some(app) = title.strip_prefix("HB|").and_then(|r| r.split('|').next()) {
        let ms = probe.ms();
        probe.inner.lock().unwrap().doc_beats.entry(app.to_owned()).or_default().push(ms);
        return;
    }
    let parts: Vec<&str> = title.splitn(6, '|').collect();
    let [tag, app, kind, i, n, chunk] = parts.as_slice() else { return };
    if *tag != "PROBE" {
        return;
    }
    let (Ok(i), Ok(n)) = (i.parse::<usize>(), n.parse::<usize>()) else { return };
    let key = format!("{app}.{kind}");
    let joined = {
        let mut inner = probe.inner.lock().unwrap();
        if inner.events.contains_key(&key) || i >= n {
            return;
        }
        let slots = inner.chunks.entry(key.clone()).or_insert_with(|| vec![None; n]);
        if slots.len() != n {
            return;
        }
        slots[i] = Some((*chunk).to_owned());
        if !slots.iter().all(Option::is_some) {
            return;
        }
        slots.iter().flatten().map(String::as_str).collect::<String>()
    };
    let value = base64::engine::general_purpose::STANDARD
        .decode(joined)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(|| json!({ "decodeError": true }));
    probe.event(key, json!({ "via": "title", "label": label, "report": value }));
}

const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn respond(status: u16, ctype: &str, body: Vec<u8>, csp: Option<String>) -> http::Response<Vec<u8>> {
    let mut b = http::Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    if let Some(p) = csp {
        b = b.header("Content-Security-Policy", p);
    }
    b.body(body).unwrap()
}

fn scheme_handler<R: Runtime>(
    scheme_app: &'static str,
) -> impl Fn(tauri::UriSchemeContext<'_, R>, http::Request<Vec<u8>>) -> http::Response<Vec<u8>> + Send + Sync + 'static {
    move |ctx, request| {
        let app = ctx.app_handle();
        let probe = app.state::<Probe>();
        let label = ctx.webview_label().to_owned();
        let fixture = label_app(&label).unwrap_or(scheme_app);
        let path = request.uri().path().to_owned();
        let query = request.uri().query().unwrap_or("").to_owned();
        probe.append(
            "scheme.log",
            json!({
                "scheme": scheme_of(scheme_app),
                "webview": label,
                "uri": request.uri().to_string(),
                "origin": request.headers().get("origin").and_then(|h| h.to_str().ok()),
                "ms": probe.ms(),
            }),
        );
        let s = spec(&probe.variant);
        let policy = policy_text(s.policy, &probe.hash, fixture);
        let mode = if label == "main" { "frame" } else { "window" };
        match path.as_str() {
            "/index.html" => {
                let phase = next_phase(&probe, fixture);
                let cfg = fixture_cfg(app, &probe, fixture, mode, json!({ "phase": phase }));
                respond(200, "text/html; charset=utf-8", fixture_html(&cfg, None, fixture).into_bytes(), policy)
            }
            "/wrap.html" => {
                let route = query.strip_prefix("r=").unwrap_or("none").to_owned();
                let phase = next_phase(&probe, fixture);
                let s1 = HASH_SCRIPTS[0].2;
                let fcfg = fixture_cfg(app, &probe, fixture, "frame", json!({ "route": route, "phase": phase, "bridge": s.bridge.map(String::from), "s1": s1 }));
                let (srcdoc, doc_hashes) = match s.group {
                    Group::Docs => author_doc(&fcfg),
                    Group::Hashes => {
                        let (markup, mut hashes) = hash_markup();
                        hashes.push(probe.hash.clone());
                        let srcs: String = hashes.iter().map(|h| format!(" '{h}'")).collect();
                        (fixture_html_with(&fcfg, Some(&format!("default-src 'none'; script-src{srcs}")), fixture, &markup), hashes)
                    }
                    Group::Style => (fixture_html_with(&fcfg, Some(&format!("default-src 'none'; script-src '{}'; {STYLE_SOURCES}", probe.hash)), fixture, &style_markup()), vec![probe.hash.clone()]),
                    _ => (fixture_html(&fcfg, policy_text(Policy::Base, &probe.hash, fixture).as_deref(), fixture), vec![probe.hash.clone()]),
                };
                probe.note("docHashes", json!(doc_hashes));
                let wcfg = json!({
                    "app": fixture, "group": format!("{:?}", s.group), "variant": probe.variant, "route": route, "phase": phase, "srcdoc": srcdoc, "sandbox": s.frame_sandbox,
                    "bridge": s.bridge.map(String::from), "bridgeUrl": format!("{}bridge", own_base(fixture)),
                });
                let wpolicy = wrapper_policy(&probe.wrap_hash, &doc_hashes, s.frame_src_open, s.bridge, fixture, s.style_policy, isolation_source(&probe));
                probe.note("wrapperPolicy", json!(wpolicy));
                respond(200, "text/html; charset=utf-8", wrapper_html(&wcfg, fixture).into_bytes(), Some(wpolicy))
            }
            "/bridge" => {
                let body: Value = serde_json::from_slice(request.body()).unwrap_or(Value::Null);
                let origin = request.headers().get("origin").and_then(|h| h.to_str().ok()).map(str::to_owned);
                let reply = bridge_answer(app, &label, &format!("scheme {}", request.method()), origin, &body);
                respond(200, "application/json", serde_json::to_vec(&reply).unwrap(), None)
            }
            "/nav.html" => {
                let route = query.strip_prefix("r=").unwrap_or("none").to_owned();
                let cfg = fixture_cfg(app, &probe, fixture, "nav", json!({ "route": route }));
                respond(200, "text/html; charset=utf-8", fixture_html(&cfg, None, fixture).into_bytes(), policy)
            }
            "/asset/mod.js" => respond(200, "text/javascript", b"globalThis.__probeModule = 'module-ran'".to_vec(), None),
            "/asset/style.css" => respond(200, "text/css", b"#probe-style { width: 123px; }".to_vec(), None),
            "/asset/img.png" => respond(200, "image/png", PNG_1X1.to_vec(), None),
            "/asset/worker.js" => respond(200, "text/javascript", b"postMessage('worker-ran')".to_vec(), None),
            _ => respond(404, "text/plain", Vec::new(), None),
        }
    }
}

fn browser_args(s: &Spec) -> Option<String> {
    let proxy = || {
        let port = std::env::var("PROBE_PROXY").unwrap_or_else(|_| "9".into());
        format!(r#"--proxy-server=http://127.0.0.1:{port} --proxy-bypass-list="<-loopback>;*.localhost""#)
    };
    let extra = match s.args {
        Args::Stock if s.unthrottle => UNTHROTTLE_ARGS.to_owned(),
        Args::Stock => return s.webrtc_arg.then(|| format!("{DEFAULT_ARGS} {WEBRTC_ARG}")),
        Args::Features => return Some(FEATURE_ARGS.to_owned()),
        Args::Hosts => HOST_RULES.to_owned(),
        Args::Proxy => proxy(),
        Args::Both => format!("{HOST_RULES} {}", proxy()),
    };
    Some(format!("{DEFAULT_ARGS} {extra}"))
}

#[cfg(windows)]
fn cancel_frame_navigations<R: Runtime>(app: &AppHandle<R>, label: &str, own: String) {
    use webview2_com::{take_pwstr, NavigationStartingEventHandler};
    let Some(webview) = app.get_webview(label) else {
        app.state::<Probe>().note("frameCancel", json!("no webview"));
        return;
    };
    let (h1, h2) = (app.clone(), app.clone());
    let l = label.to_owned();
    let sent = webview.with_webview(move |pw| {
        let result = unsafe {
            pw.controller().CoreWebView2().and_then(|core| {
                let mut token = 0i64;
                core.add_FrameNavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut uri = windows_core::PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        let allow = uri.starts_with(&own) || uri.starts_with("about:");
                        args.SetCancel(!allow)?;
                        let p = h1.state::<Probe>();
                        let ms = p.ms();
                        p.inner.lock().unwrap().navigations.push(json!({ "webview": l, "url": uri, "allow": allow, "frame": true, "ms": ms }));
                        Ok(())
                    })),
                    &mut token,
                )
            })
        };
        let p = h2.state::<Probe>();
        p.note("frameCancel", json!(result.map(|_| "registered".to_owned()).unwrap_or_else(|e| format!("error {e}"))));
    });
    if let Err(e) = sent {
        app.state::<Probe>().note("frameCancel", json!(format!("with_webview error {e}")));
    }
}

#[cfg(not(windows))]
fn cancel_frame_navigations<R: Runtime>(app: &AppHandle<R>, _: &str, _: String) {
    app.state::<Probe>().note("frameCancel", json!("not on this platform"));
}

#[cfg(target_os = "macos")]
fn no_peer_config(probe: &Probe) -> objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration> {
    use objc2::runtime::Bool;
    let mtm = objc2::MainThreadMarker::new().expect("main thread");
    unsafe {
        let config = objc2_web_kit::WKWebViewConfiguration::new(mtm);
        let prefs = config.preferences();
        let before: Bool = objc2::msg_send![&*prefs, _peerConnectionEnabled];
        let _: () = objc2::msg_send![&*prefs, _setPeerConnectionEnabled: Bool::NO];
        let after: Bool = objc2::msg_send![&*prefs, _peerConnectionEnabled];
        probe.note("peerConnectionEnabled", json!({ "before": before.as_bool(), "after": after.as_bool() }));
        config
    }
}

#[cfg(target_os = "macos")]
fn unthrottled_config(probe: &Probe) -> objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration> {
    let mtm = objc2::MainThreadMarker::new().expect("main thread");
    unsafe {
        let config = objc2_web_kit::WKWebViewConfiguration::new(mtm);
        let prefs = config.preferences();
        let before = prefs.inactiveSchedulingPolicy().0;
        prefs.setInactiveSchedulingPolicy(objc2_web_kit::WKInactiveSchedulingPolicy::None);
        let after = prefs.inactiveSchedulingPolicy().0;
        probe.note("inactiveSchedulingPolicy", json!({ "before": before, "after": after, "values": "0 suspend, 1 throttle, 2 none" }));
        config
    }
}

#[cfg(target_os = "macos")]
fn hold_activity() {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    unsafe {
        let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
        let reason: Retained<AnyObject> = msg_send![class!(NSString), stringWithUTF8String: c"probe".as_ptr()];
        let options: u64 = 0x00FF_FFFF | 0xFF_0000_0000;
        let token: Retained<AnyObject> = msg_send![&*info, beginActivityWithOptions: options, reason: &*reason];
        std::mem::forget(token);
    }
}

fn hide_all() -> bool {
    std::env::var("PROBE_HIDE_ALL").is_ok_and(|v| v == "1")
}

fn processes() -> Value {
    let (cmd, args): (&str, Vec<&str>) = if cfg!(windows) {
        ("powershell", vec!["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ForEach-Object { \"$($_.ProcessId) $([int64]($_.WorkingSetSize / 1024)) $($_.CommandLine)\" }"])
    } else if cfg!(target_os = "macos") {
        ("ps", vec!["-axo", "pid=,rss=,comm="])
    } else {
        ("ps", vec!["-eo", "pid=,rss=,args="])
    };
    let Ok(out) = std::process::Command::new(cmd).args(&args).output() else { return json!({ "error": "process listing failed" }) };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut rows = vec![];
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(rss)) = (it.next(), it.next()) else { continue };
        let rest: String = it.collect::<Vec<_>>().join(" ");
        let kind = if cfg!(windows) {
            rest.split("--type=").nth(1).map(|t| t.split(' ').next().unwrap_or("").to_owned()).unwrap_or_else(|| "browser".into())
        } else if let Some(k) = ["WebKitWebProcess", "WebKitNetworkProcess", "WebKitGPUProcess", "com.apple.WebKit.WebContent", "com.apple.WebKit.Networking", "com.apple.WebKit.GPU"].iter().find(|k| rest.contains(*k)) {
            (*k).to_owned()
        } else {
            continue;
        };
        rows.push(json!({ "pid": pid.parse::<u64>().unwrap_or(0), "rssKiB": rss.parse::<u64>().unwrap_or(0), "kind": kind }));
    }
    let mut by_kind: Map<String, Value> = Map::new();
    for r in &rows {
        let k = r["kind"].as_str().unwrap_or("").to_owned();
        let e = by_kind.entry(k).or_insert(json!({ "count": 0, "rssKiB": 0 }));
        e["count"] = json!(e["count"].as_u64().unwrap_or(0) + 1);
        e["rssKiB"] = json!(e["rssKiB"].as_u64().unwrap_or(0) + r["rssKiB"].as_u64().unwrap_or(0));
    }
    let total: u64 = rows.iter().map(|r| r["rssKiB"].as_u64().unwrap_or(0)).sum();
    json!({ "method": if cfg!(windows) { "Win32_Process WorkingSetSize" } else { "ps rss" }, "count": rows.len(), "totalKiB": total, "byKind": by_kind, "rows": rows })
}

macro_rules! configure {
    ($builder:expr, $app:expr, $spec:expr, $label:expr, $own:expr) => {{
        let mut b = $builder;
        let s: &Spec = $spec;
        if s.init_all_frames {
            b = b.initialization_script_for_all_frames(INIT_SCRIPT);
        }
        if s.group == Group::Docs {
            b = b.initialization_script_for_all_frames(DOCS_INIT);
        }
        if let Some(args) = browser_args(s) {
            b = b.additional_browser_args(&args);
        }
        #[cfg(target_os = "macos")]
        if s.no_peer {
            b = b.with_webview_configuration(no_peer_config(&$app.state::<Probe>()));
        }
        #[cfg(target_os = "macos")]
        if s.unthrottle || hide_all() {
            b = b.with_webview_configuration(unthrottled_config(&$app.state::<Probe>()));
        }
        if s.group == Group::Nav || s.wrap {
            let guard = s.nav_guard;
            let wrap = s.wrap;
            let own: Option<String> = $own;
            let (h1, h2, h3) = ($app.clone(), $app.clone(), $app.clone());
            let label = $label.to_owned();
            let (l1, l2) = (label.clone(), label.clone());
            b = b.on_navigation(move |url| {
                let app_owned = wrap && (url.scheme() == "about" || url.scheme() == "isolation" || url.host_str() == Some("isolation.localhost"));
                let allow = !guard || app_owned || own.as_deref().is_some_and(|o| url.as_str().starts_with(o));
                let p = h1.state::<Probe>();
                let ms = p.ms();
                p.inner.lock().unwrap().navigations.push(json!({ "webview": l1, "url": url.as_str(), "allow": allow, "ms": ms }));
                allow
            });
            b = b.on_new_window(move |url, _| {
                let p = h2.state::<Probe>();
                let ms = p.ms();
                p.inner.lock().unwrap().new_windows.push(json!({ "webview": l2, "url": url.as_str(), "response": if guard { "deny" } else { "allow" }, "ms": ms }));
                if guard { NewWindowResponse::Deny } else { NewWindowResponse::Allow }
            });
            b = b.on_download(move |w, event| {
                let p = h3.state::<Probe>();
                let ms = p.ms();
                let entry = match event {
                    DownloadEvent::Requested { url, destination } => {
                        *destination = p.dir.join("download.bin");
                        json!({ "webview": w.label(), "event": "requested", "url": url.as_str(), "allow": !guard, "ms": ms })
                    }
                    DownloadEvent::Finished { url, success, .. } => json!({ "webview": w.label(), "event": "finished", "url": url.as_str(), "success": success, "ms": ms }),
                    _ => json!({ "webview": w.label(), "event": "other", "ms": ms }),
                };
                p.inner.lock().unwrap().downloads.push(entry);
                !guard
            });
        }
        b
    }};
}

fn app_url(s: &Spec, a: &App) -> WebviewUrl {
    let page = match (s.wrap, s.group == Group::Nav) {
        (true, true) => "wrap.html?r=none",
        (true, false) => "wrap.html",
        (false, true) => "nav.html?r=none",
        (false, false) => "index.html",
    };
    WebviewUrl::CustomProtocol(format!("{}{page}", own_base(a.scheme_app)).parse().unwrap())
}

fn open_apps<R: Runtime>(app: &AppHandle<R>, s: &Spec) {
    for i in 0..s.apps.len() {
        open_app(app, s, i);
    }
}

fn open_app<R: Runtime>(app: &AppHandle<R>, s: &Spec, i: usize) {
    {
        let a = &s.apps[i];
        let url = app_url(s, a);
        let label = a.label;
        let own = Some(own_base(a.scheme_app));
        let handle = app.clone();
        let title_label = label.to_string();
        match s.layout {
            Layout::Windows => {
                let (w, h) = if s.group == Group::Docs { (1280.0, 800.0) } else { (640.0, 480.0) };
                let builder = WebviewWindowBuilder::new(app, label, url)
                    .title(format!("fixture {}", a.app))
                    .visible(s.surface == Surface::Visible && !hide_all())
                    .inner_size(w, h)
                    .position(700.0 + 40.0 * i as f64, 40.0 + 40.0 * i as f64)
                    .on_document_title_changed(move |_, title| on_title_app(&handle, &title_label, &title));
                let window = configure!(builder, app, s, label, own).build().expect("fixture window");
                let h = app.clone();
                let l = label.to_owned();
                window.on_window_event(move |e| {
                    if let WindowEvent::Destroyed = e {
                        let p = h.state::<Probe>();
                        let ms = p.ms();
                        p.inner.lock().unwrap().destroyed.insert(l.clone(), ms);
                    }
                });
            }
            Layout::Children => add_child(app, s, label, url, i, own, move |title| on_title_app(&handle, &title_label, &title)),
            Layout::Frames => {}
        }
        if s.frame_cancel {
            cancel_frame_navigations(app, label, own_base(a.scheme_app));
        }
    }
}

#[cfg(feature = "v4")]
fn add_child<R: Runtime>(app: &AppHandle<R>, s: &Spec, label: &str, url: WebviewUrl, i: usize, own: Option<String>, on: impl Fn(String) + Send + 'static) {
    let shell = app.get_window("shell").expect("shell window");
    let builder = tauri::webview::WebviewBuilder::new(label, url).on_document_title_changed(move |_, t| on(t));
    let (x, y, w, h) = match s.surface {
        Surface::Zero => (600.0, 0.0, 0.0, 0.0),
        Surface::Offscreen => (-5000.0, -5000.0, 600.0, 350.0),
        _ if s.group == Group::Memory => (600.0 + 20.0 * i as f64, 20.0 * i as f64, 600.0, 350.0),
        _ => (600.0, 350.0 * i as f64, 600.0, 350.0),
    };
    let child = shell
        .add_child(configure!(builder, app, s, label, own), tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(w, h))
        .expect("child webview");
    if s.surface == Surface::HiddenChild {
        let r = child.hide().map(|_| "ok".to_owned()).unwrap_or_else(|e| format!("error {e}"));
        app.state::<Probe>().note("childHide", json!(r));
    }
}

#[cfg(not(feature = "v4"))]
fn add_child<R: Runtime>(_: &AppHandle<R>, _: &Spec, _: &str, _: WebviewUrl, _: usize, _: Option<String>, _: impl Fn(String) + Send + 'static) {
    panic!("children need the v4 feature");
}

#[cfg(feature = "v4")]
fn open_host_child<R: Runtime>(app: &AppHandle<R>, s: &Spec) {
    let shell = tauri::window::WindowBuilder::new(app, "shell")
        .title("webview policy probe")
        .visible(!s.host_hidden && !hide_all())
        .inner_size(1200.0, 700.0)
        .build()
        .expect("shell window");
    let builder = tauri::webview::WebviewBuilder::new("main", WebviewUrl::App("index.html".into()));
    let builder = if let Some(args) = browser_args(s) { builder.additional_browser_args(&args) } else { builder };
    shell
        .add_child(builder, tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(600.0, 700.0))
        .expect("host child webview");
}

#[cfg(not(feature = "v4"))]
fn open_host_child<R: Runtime>(_: &AppHandle<R>, _: &Spec) {
    panic!("children need the v4 feature");
}

fn open_host<R: Runtime>(app: &AppHandle<R>, s: &Spec) -> tauri::Result<()> {
    if s.layout == Layout::Children {
        open_host_child(app, s);
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("webview policy probe")
        .visible(!s.host_hidden && !hide_all())
        .inner_size(1000.0, 700.0)
        .position(20.0, 20.0);
    let mut builder = if let Some(args) = browser_args(s) { builder.additional_browser_args(&args) } else { builder };
    if s.layout == Layout::Frames {
        if s.init_all_frames {
            builder = builder.initialization_script_for_all_frames(INIT_SCRIPT);
        }
        #[cfg(target_os = "macos")]
        if s.no_peer {
            builder = builder.with_webview_configuration(no_peer_config(&app.state::<Probe>()));
        }
    }
    builder.build()?;
    Ok(())
}

fn finish<R: Runtime>(app: &AppHandle<R>, complete: bool) {
    let probe = app.state::<Probe>();
    let mut inner = probe.inner.lock().unwrap();
    if inner.written {
        return;
    }
    inner.written = true;
    let report = json!({
        "variant": probe.variant,
        "launch": probe.launch,
        "complete": complete,
        "ms": probe.ms(),
        "webviewVersion": tauri::webview_version().ok(),
        "events": inner.events,
        "navigations": inner.navigations,
        "newWindows": inner.new_windows,
        "downloads": inner.downloads,
        "heartbeats": inner.heartbeats,
        "destroyed": inner.destroyed,
        "notes": inner.notes,
        "partialChunks": inner.chunks.iter().map(|(k, v)| (k.clone(), json!(format!("{}/{}", v.iter().flatten().count(), v.len())))).collect::<Map<_, _>>(),
    });
    std::fs::write(probe.dir.join("report.json"), serde_json::to_vec_pretty(&report).unwrap()).expect("write report");
    drop(inner);
    app.exit(if complete { 0 } else { 3 });
}

fn wait_for(probe: &Probe, keys: &[String], limit: Duration) -> bool {
    let until = Instant::now() + limit;
    while Instant::now() < until {
        if keys.iter().all(|k| probe.has(k)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn eval_on<R: Runtime>(app: &AppHandle<R>, label: &str, js: &str) -> Value {
    match app.get_webview(label) {
        Some(w) => match w.eval(js) {
            Ok(()) => json!("sent"),
            Err(e) => json!(format!("error {e}")),
        },
        None => json!("no webview"),
    }
}

fn app_keys(s: &Spec, kind: &str) -> Vec<String> {
    let apps: Vec<&str> = if s.layout == Layout::Frames { s.frames.iter().map(|f| f.app).collect() } else { s.apps.iter().map(|a| a.app).collect() };
    apps.iter().map(|a| format!("{a}.{kind}")).collect()
}

fn max_gap(beats: &[u64], from: u64, to: u64) -> Value {
    let before = beats.iter().copied().filter(|&b| b <= from).max();
    let inside: Vec<u64> = beats.iter().copied().filter(|&b| b > from && b <= to).collect();
    let mut points: Vec<u64> = before.into_iter().chain(inside.iter().copied()).collect();
    points.push(to);
    let gap = points.windows(2).map(|w| w[1] - w[0]).max().unwrap_or(to - from);
    json!({ "maxGapMs": gap, "beats": inside.len(), "lastBeforeMs": before })
}

fn control<R: Runtime>(handle: AppHandle<R>) {
    let probe = handle.state::<Probe>();
    let s = spec(&probe.variant);
    while !probe.inner.lock().unwrap().config_served {
        if probe.started.elapsed() > DEADLINE {
            return finish(&handle, false);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if cfg!(feature = "iso") {
        let found = wait_for(&probe, &["host.isolation".to_owned()], Duration::from_secs(10));
        probe.note("isolationSource", json!({ "found": found, "source": isolation_source(&probe) }));
    }
    if !s.apps.is_empty() && s.group != Group::Memory {
        let h = handle.clone();
        let s2 = spec(&probe.variant);
        handle.run_on_main_thread(move || open_apps(&h, &s2)).expect("main thread");
    }
    let complete = match s.group {
        Group::Surface => surface(&handle, &probe, &s),
        Group::Memory => memory(&handle, &probe, &s),
        Group::Docs => {
            std::thread::sleep(Duration::from_secs(8));
            let sent = eval_on(&handle, s.apps[0].label, "window.__probeDocsReport()");
            probe.note("docsReport", json!({ "sent": sent, "atMs": probe.ms() }));
            let ok = wait_for(&probe, &app_keys(&s, "done"), Duration::from_secs(30));
            std::thread::sleep(Duration::from_millis(1500));
            ok
        }
        Group::Rtc | Group::Ipc | Group::Assets | Group::Style | Group::Hashes => {
            let mut keys = app_keys(&s, "done");
            if s.group == Group::Ipc {
                keys.push("host.hostcall".into());
            }
            let ok = wait_for(&probe, &keys, Duration::from_secs(60));
            std::thread::sleep(Duration::from_millis(1500));
            ok
        }
        Group::Nav => {
            let label = s.apps[0].label;
            let ok = wait_for(&probe, &app_keys(&s, "navready-none"), Duration::from_secs(30));
            let (routes, page, pause): (&[&str], &str, u64) = if s.wrap { (&NAV2_ROUTES, "wrap.html", 5000) } else { (&NAV_ROUTES, "nav.html", 3500) };
            for route in routes {
                let url: tauri::Url = format!("{}{page}?r={route}", own_base(s.apps[0].scheme_app)).parse().unwrap();
                let started = probe.ms();
                let sent = match handle.get_webview(label) {
                    Some(w) => w.navigate(url).map(|_| "sent".to_owned()).unwrap_or_else(|e| format!("error {e}")),
                    None => "no webview".into(),
                };
                std::thread::sleep(Duration::from_millis(pause));
                let at = handle.get_webview(label).and_then(|w| w.url().ok()).map(|u| u.to_string());
                probe.note(&format!("route.{route}"), json!({ "startedMs": started, "navigate": sent, "urlAfter": at }));
            }
            ok
        }
        Group::Storage => {
            let ok = wait_for(&probe, &app_keys(&s, &format!("done-{}", if probe.launch == 1 { "write" } else { "launch2load1" })), Duration::from_secs(40));
            if probe.launch == 1 {
                for a in &s.apps {
                    let r = handle.get_webview(a.label).map(|w| w.reload().map(|_| "sent".to_owned()).unwrap_or_else(|e| format!("error {e}")));
                    probe.note(&format!("reload.{}", a.app), json!(r));
                    std::thread::sleep(Duration::from_millis(300));
                }
                let reloaded = wait_for(&probe, &app_keys(&s, "done-reload1"), Duration::from_secs(40));
                std::thread::sleep(Duration::from_millis(1000));
                ok && reloaded
            } else {
                std::thread::sleep(Duration::from_millis(1000));
                ok
            }
        }
        Group::Hang => hang(&handle, &probe, &s),
        Group::Bridge => {
            let ok = wait_for(&probe, &app_keys(&s, "rt-done"), Duration::from_secs(90));
            for a in &s.apps {
                let ms = probe.ms();
                let sent = eval_on(&handle, a.label, &format!("window.__bridgeEvent({})", json!({ "from": "host", "atMs": ms })));
                probe.note(&format!("event.{}", a.app), json!({ "atMs": ms, "sent": sent }));
            }
            let done = wait_for(&probe, &app_keys(&s, "done"), Duration::from_secs(200));
            std::thread::sleep(Duration::from_millis(1500));
            for a in &s.apps {
                let at = handle.get_webview(a.label).and_then(|w| w.url().ok()).map(|u| u.to_string());
                probe.note(&format!("urlAfter.{}", a.app), json!(at));
            }
            ok && done
        }
    };
    finish(&handle, complete);
}

fn close_container<R: Runtime>(handle: &AppHandle<R>, s: &Spec, label: &str) -> Value {
    if s.layout == Layout::Windows {
        let r = handle.get_webview_window(label).map(|w| w.destroy().map(|_| "ok".to_owned()).unwrap_or_else(|e| format!("error {e}")));
        json!({ "action": "window destroy", "call": r })
    } else {
        let r = handle.get_webview(label).map(|w| w.close().map(|_| "ok".to_owned()).unwrap_or_else(|e| format!("error {e}")));
        json!({ "action": "child webview close", "call": r })
    }
}

fn surface<R: Runtime>(handle: &AppHandle<R>, probe: &Probe, s: &Spec) -> bool {
    let label = s.apps[0].label;
    let ok = wait_for(probe, &app_keys(s, "ready"), Duration::from_secs(40));
    let t_ready = probe.ms();
    probe.note("surfaceMode", json!({ "surface": format!("{:?}", s.surface), "unthrottle": s.unthrottle, "readyMs": t_ready, "ready": ok }));
    std::thread::sleep(Duration::from_secs(30));
    let at = probe.ms();
    let sent = eval_on(handle, label, &format!("window.__bridgeEvent({})", json!({ "from": "host", "atMs": at })));
    probe.note("event.A", json!({ "atMs": at, "sent": sent }));
    let done = wait_for(probe, &app_keys(s, "done"), Duration::from_secs(90));
    let t_done = probe.ms();
    let before = processes();
    let close = close_container(handle, s, label);
    std::thread::sleep(Duration::from_secs(5));
    let after = processes();
    let beats = probe.inner.lock().unwrap().doc_beats.get("A").cloned().unwrap_or_default();
    let in_window = beats.iter().filter(|&&b| b > t_ready && b <= t_ready + 60_000).count();
    let gaps: Vec<u64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    probe.note("surface", json!({ "beatsIn60s": in_window, "beatsTotal": beats.len(), "maxGapMs": gaps.iter().max(), "doneMs": t_done, "done": done, "close": close, "before": before, "after": after }));
    ok && done
}

fn memory<R: Runtime>(handle: &AppHandle<R>, probe: &Probe, s: &Spec) -> bool {
    let open = |i: usize| {
        let h = handle.clone();
        let variant = probe.variant.clone();
        handle.run_on_main_thread(move || open_app(&h, &spec(&variant), i)).expect("main thread");
    };
    std::thread::sleep(Duration::from_secs(10));
    let zero = processes();
    open(0);
    let ok = wait_for(probe, &app_keys(s, "ready"), Duration::from_secs(40));
    std::thread::sleep(Duration::from_secs(10));
    let one = processes();
    for i in 1..s.apps.len() {
        open(i);
    }
    std::thread::sleep(Duration::from_secs(14));
    let four = processes();
    let loaded = probe.inner.lock().unwrap().events.get("A.ready").cloned();
    probe.note("memory", json!({ "surface": format!("{:?}", s.surface), "layout": if s.layout == Layout::Windows { "windows" } else { "children" }, "zero": zero, "one": one, "four": four, "firstReady": loaded.is_some() }));
    ok
}

fn hang<R: Runtime>(handle: &AppHandle<R>, probe: &Probe, s: &Spec) -> bool {
    let ok = wait_for(probe, &app_keys(s, "ready"), Duration::from_secs(40));
    std::thread::sleep(Duration::from_millis(1500));
    let t_hang = probe.ms();
    let sent = if s.host_hang {
        eval_on(handle, "main", "window.__probeHostHang(3000)")
    } else if s.layout == Layout::Frames {
        eval_on(handle, "main", "window.__probeHang()")
    } else {
        eval_on(handle, s.apps[0].label, "window.__probeHang()")
    };
    probe.note("hang", json!({ "atMs": t_hang, "trigger": sent }));
    if s.bridge.is_some() {
        std::thread::sleep(Duration::from_millis(1000));
        let mut asked = vec![];
        for (i, a) in s.apps.iter().enumerate() {
            let id = 5000 + i as u64;
            let at = probe.ms();
            let sent = eval_on(handle, a.label, &format!("window.__bridgeHostRequest({id})"));
            asked.push((a, id, at, sent));
        }
        let until = Instant::now() + Duration::from_millis(3000);
        while Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        let replies = probe.inner.lock().unwrap().host_replies.clone();
        let result: Vec<Value> = asked
            .iter()
            .map(|(a, id, at, sent)| {
                let got = replies.iter().find(|r| r["id"].as_u64() == Some(*id) && r["label"].as_str() == Some(a.label)).and_then(|r| r["ms"].as_u64());
                json!({ "app": a.app, "label": a.label, "sent": sent, "replied": got.is_some(), "replyMs": got.map(|g| g.saturating_sub(*at)), "timeoutMs": 3000 })
            })
            .collect();
        probe.note("hostRequests", json!(result));
        let elapsed = probe.ms().saturating_sub(t_hang);
        std::thread::sleep(Duration::from_millis(5_000u64.saturating_sub(elapsed)));
    } else {
        std::thread::sleep(Duration::from_millis(if s.wrap { 5_000 } else { 10_000 }));
    }
    let t_rm = probe.ms();
    let removal = if s.host_hang {
        json!({ "action": "none" })
    } else if s.layout == Layout::Frames {
        let sent = eval_on(handle, "main", "window.__probeRemove()");
        let done = wait_for(probe, &["host.removed".to_owned()], Duration::from_secs(10));
        let at = probe.inner.lock().unwrap().events.get("host.removed").and_then(|e| e["ms"].as_u64());
        json!({ "action": "frame removed by host page", "trigger": sent, "completed": done, "doneMs": at.map(|a| a.saturating_sub(t_rm)) })
    } else if s.layout == Layout::Windows {
        let label = s.apps[0].label;
        let r = handle.get_webview_window(label).map(|w| w.destroy().map(|_| "ok".to_owned()).unwrap_or_else(|e| format!("error {e}")));
        let returned = probe.ms() - t_rm;
        let until = Instant::now() + Duration::from_secs(10);
        let mut at = None;
        while Instant::now() < until {
            if let Some(ms) = probe.inner.lock().unwrap().destroyed.get(label).copied() {
                at = Some(ms - t_rm);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        json!({ "action": "window destroy", "call": r, "callReturnedMs": returned, "completed": at.is_some(), "doneMs": at })
    } else {
        let label = s.apps[0].label;
        let r = handle.get_webview(label).map(|w| w.close().map(|_| "ok".to_owned()).unwrap_or_else(|e| format!("error {e}")));
        let returned = probe.ms() - t_rm;
        let until = Instant::now() + Duration::from_secs(10);
        let mut at = None;
        while Instant::now() < until {
            if handle.get_webview(label).is_none() {
                at = Some(probe.ms() - t_rm);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        json!({ "action": "child webview close", "call": r, "callReturnedMs": returned, "completed": at.is_some(), "doneMs": at })
    };
    std::thread::sleep(Duration::from_millis(2500));
    let t_end = probe.ms();
    let (beats, doc, wrapper, other_doc, other_wrapper) = {
        let inner = probe.inner.lock().unwrap();
        let get = |k: &str| inner.doc_beats.get(k).cloned().unwrap_or_default();
        (inner.heartbeats.clone(), get("A"), get("W"), get("B"), get("WB"))
    };
    probe.note(
        "hangResult",
        json!({
            "during": max_gap(&beats, t_hang, t_rm),
            "afterRemoval": max_gap(&beats, t_rm, t_end),
            "removal": removal,
            "beforeHang": max_gap(&beats, t_hang.saturating_sub(1500), t_hang),
            "documentBefore": max_gap(&doc, t_hang.saturating_sub(1500), t_hang),
            "documentDuring": max_gap(&doc, t_hang, t_rm),
            "wrapperBefore": max_gap(&wrapper, t_hang.saturating_sub(1500), t_hang),
            "wrapperDuring": max_gap(&wrapper, t_hang, t_rm),
            "otherDocumentDuring": max_gap(&other_doc, t_hang, t_rm),
            "otherWrapperDuring": max_gap(&other_wrapper, t_hang, t_rm),
            "loopMs": t_rm - t_hang,
        }),
    );
    ok
}

fn main() {
    let variant_name = std::env::var("PROBE_VARIANT").expect("PROBE_VARIANT");
    let dir = PathBuf::from(std::env::var("PROBE_DIR").expect("PROBE_DIR"));
    std::fs::create_dir_all(&dir).expect("probe dir");
    trace::install(dir.join("trace.jsonl"));
    #[cfg(target_os = "macos")]
    if hide_all() || spec(&variant_name).hold_activity {
        hold_activity();
    }
    let hash = format!("sha256-{}", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(FIXTURE_JS.as_bytes())));
    let stun_ports: Vec<String> = std::env::var("PROBE_STUN").expect("PROBE_STUN").split(',').map(str::to_owned).collect();
    let stun: Map<String, Value> = WEBRTC_ROUTES.iter().zip(stun_ports.iter()).map(|(r, p)| (r.to_string(), json!(p))).collect();
    let probe = Probe {
        variant: variant_name.clone(),
        launch: std::env::var("PROBE_LAUNCH").ok().and_then(|l| l.parse().ok()).unwrap_or(1),
        dir,
        sink: std::env::var("PROBE_SINK").expect("PROBE_SINK"),
        stun,
        nonce: std::env::var("PROBE_NONCE").unwrap_or_else(|_| "n0".into()),
        hash,
        wrap_hash: format!("sha256-{}", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(WRAPPER_JS.as_bytes()))),
        started: Instant::now(),
        inner: Mutex::new(Inner::default()),
    };
    let s = spec(&variant_name);
    probe.note("pattern", json!(if cfg!(feature = "iso") { "isolation" } else { "brownfield" }));
    probe.note("browserArgs", json!(browser_args(&s)));

    tauri::Builder::default()
        .manage(probe)
        .plugin(probe_plugin::init())
        .register_uri_scheme_protocol("appa", scheme_handler("A"))
        .register_uri_scheme_protocol("appb", scheme_handler("B"))
        .invoke_handler(tauri::generate_handler![probe_mark, probe_config, probe_event, probe_heartbeat, probe_report, bridge_call])
        .setup(move |app| {
            open_host(app.handle(), &s)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || control(handle));
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(DEADLINE);
                finish(&handle, false);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run webview policy probe");
}
