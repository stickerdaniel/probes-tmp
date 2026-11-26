import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { until } from './chrome.mjs';

const since = (end, start) => Math.round(end - start);

export function observeWorker(chrome, fixture, workerUrl) {
  const live = new Map();
  let latest;
  chrome.events.on('Target.targetCreated', ({ targetInfo }) => {
    if (targetInfo.type !== 'service_worker' || targetInfo.url !== workerUrl) return;
    const target = targetInfo.targetId;
    latest = fixture.observe('start', { target });
    live.set(target, latest);
  });
  chrome.events.on('Target.targetDestroyed', ({ targetId }) => {
    if (!live.delete(targetId)) return;
    fixture.observe('stop', { target: targetId });
  });
  return {
    current: () => [...live.values()].at(-1),
    latest: () => latest,
    live,
  };
}

export async function grantFixture(chrome, fixture, control, id) {
  const admin = await chrome.page('chrome://extensions/');
  const host = new URL(fixture.origin).hostname;
  const pattern = 'https://' + host + '/*';
  await chrome.evaluate(admin.sessionId, (id, pattern) => new Promise((resolve, reject) => {
    chrome.developerPrivate.addHostPermission(id, pattern, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(true);
    });
  }), id, pattern);
  await chrome.send('Target.closeTarget', { targetId: admin.targetId });
  await chrome.send('Target.activateTarget', { targetId: control.targetId });
  const grant = await chrome.send('Runtime.evaluate', {
    expression: 'chrome.permissions.request(' + JSON.stringify({ origins: [pattern] }) + ')',
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, control.sessionId);
  assert.equal(grant.result?.value, true,
    grant.exceptionDetails?.exception?.description ?? 'Missing optional fixture host grant');
}

export async function wirePage(chrome, fixture, control, after = null) {
  const previous = fixture.log.filter(row => row.type === 'connected').length;
  const tab = await chrome.page(fixture.origin + '/');
  await chrome.evaluate(control.sessionId, async origin => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.url === origin + '/');
    if (!tab) throw new Error('Missing fixture tab');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }, fixture.origin);
  await chrome.evaluate(tab.sessionId, cursor => { globalThis.openStream(cursor); }, after);
  await until(() => fixture.log.filter(row => row.type === 'connected').length > previous, 'stream connection');
  await chrome.send('Target.detachFromTarget', { sessionId: tab.sessionId });
  return tab.targetId;
}

export const rowFor = (fixture, type, id) => fixture.log.find(row => row.type === type && row.value.id === id);

export async function stopAndRestart(chrome, fixture, worker, control, workerUrl, native) {
  const wake = () => chrome.evaluate(control.sessionId, () => chrome.runtime.sendMessage({ kind: 'wake' }));
  const { boot } = await wake();
  if (native) {
    await until(() => fixture.log.some(row => row.type === 'delivery' && row.value.boot === boot &&
      row.value.kind === 'ready'), 'native host before forced stop');
  }
  const previous = await until(worker.current, 'worker before forced stop');
  const versions = new Map();
  const onUpdate = ({ versions: changed }, sessionId) => {
    if (sessionId !== control.sessionId) return;
    for (const version of changed) versions.set(version.versionId, version);
  };
  chrome.events.on('ServiceWorker.workerVersionUpdated', onUpdate);
  await chrome.send('ServiceWorker.enable', {}, control.sessionId);
  const version = await until(() => [...versions.values()].find(
    candidate => candidate.scriptURL === workerUrl && candidate.runningStatus === 'running',
  ), 'running version', 4000);
  await chrome.send('ServiceWorker.stopWorker', { versionId: version.versionId }, control.sessionId);
  await until(() => !worker.live.has(previous.target), 'forced worker stop');
  const stopped = fixture.log.find(row => row.type === 'stop' && row.target === previous.target);
  await chrome.send('ServiceWorker.disable', {}, control.sessionId);
  chrome.events.off('ServiceWorker.workerVersionUpdated', onUpdate);
  assert(!worker.current(), 'Worker restarted before forced-stop stimulus');
  const stimulus = fixture.emit('forced', null);
  const restart = await until(() => worker.latest()?.at > stimulus.at && worker.latest(), 'worker restart', 5000)
    .catch(() => undefined);
  const received = await until(() => rowFor(fixture, 'delivery', stimulus.id), 'forced event delivery', 5000)
    .catch(() => undefined);
  await delay(300);
  const delivery = fixture.log.filter(row => row.type === 'delivery' && row.value.id === stimulus.id);
  return {
    stoppedToStimulusMs: since(stimulus.at, stopped.at),
    stimulusToStartMs: restart ? since(restart.at, stimulus.at) : null,
    stopToStartMs: restart ? since(restart.at, stopped.at) : null,
    received: Boolean(received),
    event: { sent: 1, page: Number(Boolean(rowFor(fixture, 'seen', stimulus.id))),
      deliveries: delivery.length, lost: received ? 0 : 1,
      deliveryMs: received ? since(received.at, stimulus.at) : null },
  };
}
