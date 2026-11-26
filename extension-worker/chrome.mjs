import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function until(check, label, timeout = 12_000) {
  const deadline = performance.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(40);
  } while (performance.now() < deadline);
  throw new Error('Timed out: ' + label);
}

export async function withChrome({ executable, profile, proxy, certPin, mode, hostEnv }, run) {
  const child = spawn(executable, [
    ...(mode === 'headless' ? ['--headless=new'] : []),
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-quic',
    '--metrics-recording-only',
    '--no-pings',
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-pipe',
    '--host-resolver-rules=EXCLUDE 127.0.0.1, MAP * ~NOTFOUND',
    '--proxy-bypass-list=127.0.0.1',
    '--proxy-server=' + proxy,
    '--ignore-certificate-errors-spki-list=' + certPin,
    '--user-data-dir=' + profile,
    'about:blank',
  ], {
    env: { ...process.env, ...hostEnv },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve(code ?? signal));
    child.once('error', error => resolve(error.message));
  });
  const events = new EventEmitter();
  const pending = new Map();
  let id = 0;
  let partial = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdio[3].on('error', () => {});
  child.stdio[4].setEncoding('utf8').on('data', chunk => {
    partial += chunk;
    let end;
    while ((end = partial.indexOf('\0')) !== -1) {
      const message = JSON.parse(partial.slice(0, end));
      partial = partial.slice(end + 1);
      if (message.method) events.emit(message.method, message.params, message.sessionId);
      else pending.get(message.id)?.(message);
    }
  });
  exited.then(code => {
    for (const respond of pending.values()) {
      respond({ error: { message: 'Chrome exited: ' + code } });
    }
  });
  async function send(method, params = {}, sessionId) {
    const command = ++id;
    const timeout = new AbortController();
    const response = new Promise(resolve => pending.set(command, resolve));
    child.stdio[3].write(JSON.stringify({ id: command, method, params, sessionId }) + '\0', error => {
      if (error) pending.get(command)?.({ error });
    });
    try {
      const message = await Promise.race([
        response,
        delay(12_000, { error: { message: 'Timed out' } }, { signal: timeout.signal }),
      ]);
      if (message.error) throw new Error(method + ': ' + message.error.message);
      return message.result;
    } finally {
      timeout.abort();
      pending.delete(command);
    }
  }
  async function evaluate(session, fn, ...args) {
    const reply = await send('Runtime.evaluate', {
      expression: '(' + fn + ')(...' + JSON.stringify(args) + ')',
      returnByValue: true,
      awaitPromise: true,
    }, session);
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    }
    return reply.result.value;
  }
  async function page(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const navigation = await send('Page.navigate', { url }, sessionId);
    if (navigation.errorText) throw new Error('Navigate: ' + navigation.errorText);
    await until(async () => {
      try {
        return await evaluate(sessionId, url => location.href === url && document.readyState === 'complete', url);
      } catch (error) {
        if (!/context|navigat/i.test(error.message)) throw error;
      }
    }, 'page ready');
    return { targetId, sessionId };
  }
  try {
    return await run({ send, page, evaluate, events, version: await send('Browser.getVersion') });
  } catch (error) {
    console.error(JSON.stringify({ chromeStderr: stderr }));
    throw error;
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.stdio[3].end(JSON.stringify({ id: ++id, method: 'Browser.close' }) + '\0');
    }
    const timeout = new AbortController();
    try {
      await Promise.race([
        exited,
        delay(4000, undefined, { signal: timeout.signal }).then(async () => {
          child.kill('SIGKILL');
          await exited;
        }),
      ]);
    } finally {
      timeout.abort();
    }
  }
}
