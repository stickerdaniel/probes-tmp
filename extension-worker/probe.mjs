import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { until, withChrome } from './chrome.mjs';
import { withFixture } from './fixture.mjs';
import { chromeExecutable, createProfile, registerHost } from './profile.mjs';
import { grantFixture, observeWorker, rowFor, stopAndRestart, wirePage } from './instrument.mjs';

const output = process.env.PROBE_RESULTS || 'results';
const since = (end, start) => Math.round(end - start);
const select = (fixture, type) => fixture.log.filter(row => row.type === type);
const emit = ({ fixture, worker }, phase) => fixture.emit(phase, worker.current()?.target ?? null);

async function waitUntil(deadline) {
  let remaining = deadline - performance.now();
  while (remaining > 0) {
    await delay(Math.ceil(remaining));
    remaining = deadline - performance.now();
  }
}

async function certificate(directory) {
  const keyFile = join(directory, 'key.pem');
  const certFile = join(directory, 'cert.pem');
  const opensslConfig = join(directory, 'openssl.cnf');
  await writeFile(opensslConfig,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n');
  execFileSync('openssl', ['req', '-config', opensslConfig, '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=127.0.0.1'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const certPin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({
    type: 'spki', format: 'der',
  })).digest('base64');
  return { key, cert, certPin, certFile };
}

function summarize(fixture, start, end, interval) {
  const emitted = select(fixture, 'emitted').filter(row => row.phase === 'steady');
  const page = select(fixture, 'seen').filter(row => row.value.phase === 'steady');
  const delivery = select(fixture, 'delivery').filter(row => row.value.phase === 'steady');
  const deliveredIds = new Set(delivery.map(row => row.value.id));
  const missing = emitted.filter(event => !deliveredIds.has(event.id));
  const offline = emitted.filter(event => event.worker === null);
  const starts = select(fixture, 'start');
  const stops = new Map(select(fixture, 'stop').filter(row => row.at <= end).map(row => [row.target, row]));
  const inWindow = starts.filter(row => row.at <= end);
  const lifetime = inWindow.map(({ target, at }) => {
    const stop = stops.get(target);
    return { milliseconds: since(stop?.at ?? end, at), lowerBound: !stop };
  });
  const offlineWakeMs = offline.flatMap(event => {
    const next = starts.find(row => row.at >= event.at);
    return next && next.at - event.at < Math.min(interval * 1000, 5000) ? [since(next.at, event.at)] : [];
  });
  return {
    elapsedMs: since(end, start), lifetime, steadyRestarts: inWindow.filter(row => row.at > start).length,
    sent: emitted.length, page: new Set(page.map(row => row.value.id)).size, delivered: deliveredIds.size,
    lost: missing.length, lostIds: missing.map(row => row.id), duplicates: delivery.length - deliveredIds.size,
    emittedWhileStopped: offline.length, lostWhileStopped: missing.filter(row => row.worker === null).length,
    offlineWakeMs, streamConnections: select(fixture, 'connected').length,
    streamDisconnections: select(fixture, 'disconnected').length,
    hostPids: [...new Set(delivery.flatMap(row => row.value.pid ?? []))],
  };
}

async function hold(context, { interval, duration }) {
  const { chrome, fixture, worker, control, workerUrl, native } = context;
  await wirePage(chrome, fixture, control);
  const start = performance.now();
  for (let seconds = interval; seconds <= duration; seconds += interval) {
    await waitUntil(start + seconds * 1000);
    emit(context, 'steady');
  }
  await waitUntil(start + duration * 1000);
  const end = performance.now();
  await delay(1500);
  const steady = summarize(fixture, start, end, interval);
  const forced = await stopAndRestart(chrome, fixture, worker, control, workerUrl, native)
    .catch(error => ({ error: error.message }));
  return { interval, duration, steady, forced };
}

async function emitAndWait(context, phase) {
  const { id } = emit(context, phase);
  return until(() => rowFor(context.fixture, 'delivery', id), 'delivery of event ' + id);
}

async function closePage(chrome, fixture, tab) {
  const closed = await chrome.send('Target.closeTarget', { targetId: tab });
  assert.equal(closed.success, true);
  await until(() => fixture.connections() === 0, 'closed tab SSE disconnect');
}

function deliverySummary(fixture) {
  const sent = select(fixture, 'emitted').map(row => row.id);
  const frames = select(fixture, 'delivery').filter(row => row.value.kind === 'event');
  const received = frames.map(row => row.value.id);
  const unique = new Set(received);
  return {
    sent, received, lostIds: sent.filter(id => !unique.has(id)), duplicates: received.length - unique.size,
    inOrder: received.every((id, index) => index === 0 || id > received[index - 1]),
    boots: [...new Set(frames.map(row => row.value.boot))],
    hostPids: [...new Set(frames.map(row => row.value.pid))],
    connections: select(fixture, 'connected'),
  };
}

async function closedTab(context) {
  const { chrome, fixture, control, worker } = context;
  let tab = await wirePage(chrome, fixture, control);
  for (let index = 0; index < 3; index++) await emitAndWait(context, 'before-close');
  const workerBefore = worker.current()?.target ?? null;
  await closePage(chrome, fixture, tab);
  const closedAt = performance.now();
  for (const offset of [0, 17_500, 35_000]) {
    await waitUntil(closedAt + offset);
    emit(context, 'closed-no-cursor');
  }
  const workerAfter = worker.current()?.target ?? null;
  const closedMs = since(performance.now(), closedAt);
  const hostExitsWhileClosed = select(fixture, 'host-exit').filter(row => row.at >= closedAt).length;
  tab = await wirePage(chrome, fixture, control);
  let acknowledged;
  for (let index = 0; index < 3; index++) acknowledged = await emitAndWait(context, 'reopened-no-cursor');
  await closePage(chrome, fixture, tab);
  const cursor = acknowledged.value.id;
  const pending = [];
  for (let index = 0; index < 3; index++) pending.push(emit(context, 'closed-with-cursor').id);
  await wirePage(chrome, fixture, control, cursor);
  await until(() => rowFor(fixture, 'delivery', pending.at(-1)), 'replay after reopening tab');
  for (let index = 0; index < 3; index++) await emitAndWait(context, 'reopened-with-cursor');
  await delay(400);
  return {
    closedMs, workerBefore, workerAfter, hostExitsWhileClosed, cursor, replayIds: pending,
    ...deliverySummary(fixture),
  };
}

async function reconnect(context) {
  const { chrome, fixture, control } = context;
  await wirePage(chrome, fixture, control);
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    if (id === 4 || id === 7) {
      fixture.drop();
      await until(() => fixture.connections() === 0, 'scripted SSE drop');
      assert.equal(emit(context, 'during-drop').connections, 0);
      await until(() => rowFor(fixture, 'delivery', id), 'replay of event ' + id);
    } else {
      await emitAndWait(context, 'connected');
    }
  }
  await delay(400);
  return deliverySummary(fixture);
}

async function writeResult(filename, result) {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, filename + '.json'), JSON.stringify(result, null, 2) + '\n');
}

async function measure(name, settings, mode, status) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-extension-'));
  const result = {
    name, mode, native: settings.native, platform: process.platform, arch: process.arch,
    node: process.version, image: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA,
  };
  try {
    const tls = await certificate(directory);
    await withFixture(tls, async fixture => {
      result.trace = fixture.log;
      const profile = await createProfile(directory, fixture.origin, tls.certFile, settings.native);
      const host = settings.native ? await registerHost(directory, fixture.origin, profile) : null;
      result.registration = host?.registration;
      const executable = chromeExecutable();
      try {
        await withChrome({
          executable, profile: profile.profile, proxy: fixture.denyProxy,
          certPin: tls.certPin, mode, hostEnv: host?.hostEnv,
        }, async chrome => {
          result.chrome = chrome.version.product;
          result.chromiumRevision = chrome.version.revision;
          const base = 'chrome-extension://' + profile.id;
          const workerUrl = base + '/worker.js';
          const worker = observeWorker(chrome, fixture, workerUrl);
          await chrome.send('Target.setDiscoverTargets', { discover: true });
          const loaded = await chrome.send('Extensions.loadUnpacked', { path: profile.extension });
          assert.equal(loaded.id, profile.id, 'Unpacked extension ID');
          await until(worker.current, 'extension service worker start', 7000);
          if (settings.native) {
            await until(() => select(fixture, 'delivery').some(row => row.value.kind === 'ready'), 'native host initial connection');
          }
          const control = await chrome.page(base + '/control.html');
          await grantFixture(chrome, fixture, control, profile.id);
          status.ready = true;
          console.log('START ' + JSON.stringify({ name, mode, chrome: result.chrome }));
          const context = { chrome, fixture, control, worker, workerUrl, native: settings.native };
          result.measurement = await settings.run(context, settings);
          result.proxyRejected = fixture.proxyRejected();
        });
      } finally {
        host?.remove();
      }
    });
  } catch (error) {
    result.error = error.stack ?? String(error);
    await writeResult(name + '-' + mode + '-error', result);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await writeResult(name, result);
  const { trace, ...summary } = result;
  console.log('ROW ' + JSON.stringify(summary));
  return result.measurement;
}

async function run(name, settings) {
  const status = { ready: false };
  const mode = process.env.PROBE_MODE || 'headless';
  try {
    return await measure(name, settings, mode, status);
  } catch (error) {
    if (process.env.PROBE_MODE || status.ready) throw error;
    console.error('HEADLESS ' + error.message);
    return measure(name, settings, 'headed', status);
  }
}

const cases = {
  'native-1': { native: true, interval: 1, duration: 1800 },
  'native-25': { native: true, interval: 25, duration: 1800 },
  'native-35': { native: true, interval: 35, duration: 1820 },
  'runtime-35': { native: false, interval: 35, duration: 1820 },
  'runtime-300': { native: false, interval: 300, duration: 1800 },
};

async function followups(verify) {
  const closed = await run('closed-tab', { native: true, run: closedTab });
  const cursor = await run('cursor-reconnect', { native: true, run: reconnect });
  if (!verify) return;
  assert.deepEqual(closed.lostIds, [4, 5, 6], 'Events lost during plain tab reopen only');
  assert.equal(closed.workerBefore, closed.workerAfter, 'Worker target across closed tab');
  assert.equal(closed.hostExitsWhileClosed, 0, 'Native host exits across closed tab');
  assert.equal(closed.hostPids.length, 1, 'Native process across tab reopen');
  assert.equal(closed.boots.length, 1, 'Worker boot across tab reopen');
  assert.equal(closed.duplicates, 0);
  assert(closed.inOrder);
  assert.deepEqual(cursor.connections.map(row => row.lastEventId), [null, '3', '6']);
  assert.deepEqual(cursor.received, cursor.sent);
}

const [name] = process.argv.slice(2);
assert(process.platform === 'win32' || process.platform === 'darwin' || process.env.PROBE_CHROME);
if (name === 'smoke') {
  for (const [key, duration] of [['native-35', 35], ['runtime-35', 70]]) {
    const { steady, forced } = await run('smoke-' + key, { ...cases[key], duration, run: hold });
    assert.equal(steady.lost, 0);
    assert.equal(steady.duplicates, 0);
    assert.equal(steady.emittedWhileStopped, key === 'runtime-35' ? 2 : 0);
    assert.equal(forced.error, undefined);
    assert.equal(forced.event.deliveries, 1);
  }
  await followups(true);
} else if (name === 'followups') {
  await followups(false);
} else {
  assert(Object.hasOwn(cases, name), 'Unknown case ' + name);
  await run(name, { ...cases[name], run: hold });
}
