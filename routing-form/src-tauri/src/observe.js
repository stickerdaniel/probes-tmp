window.probeErrors = [];

function recordError(message) {
  window.probeErrors.push(message);
  void window.__TAURI_INTERNALS__?.invoke("record", {
    row: { kind: "web-error", message }
  }).catch(() => {});
}

window.addEventListener("error", (event) => {
  recordError(event.message || event.target?.src || event.target?.href || "resource error");
}, true);
window.addEventListener("unhandledrejection", (event) => {
  recordError(String(event.reason));
});
const reportConsole = console.error.bind(console);
console.error = (...args) => {
  recordError(args.map(String).join(" "));
  reportConsole(...args);
};
