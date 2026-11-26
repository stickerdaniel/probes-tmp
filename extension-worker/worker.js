importScripts('config.js');

const boot = crypto.randomUUID();
const nativePort = useNative ? chrome.runtime.connectNative(nativeName) : undefined;
if (nativePort) {
  nativePort.onDisconnect.addListener(() => {
    console.error(chrome.runtime.lastError?.message ?? 'Native host disconnected');
  });
  nativePort.postMessage({ kind: 'ready', boot });
}

chrome.runtime.onInstalled.addListener(() => {});
chrome.runtime.onMessage.addListener(({ kind }, _, respond) => {
  if (kind === 'wake') respond({ boot });
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'stream' || port.sender.origin !== fixtureOrigin) return;
  port.onMessage.addListener(event => {
    const frame = { ...event, kind: 'event', boot };
    if (nativePort) nativePort.postMessage(frame);
    else fetch(fixtureOrigin + '/delivery', { method: 'POST', body: JSON.stringify(frame) }).catch(console.error);
  });
});
