import { createServer as createProxy } from 'node:http';
import { createServer } from 'node:https';

const page = `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Loopback SSE</title>
<script>
globalThis.openStream = after => {
  const url = after === null ? '/sse' : '/sse?after=' + after;
  const stream = new EventSource(url);
  stream.onmessage = ({ data, lastEventId }) => {
    fetch('/seen', { method: 'POST', body: JSON.stringify({ ...JSON.parse(data), lastEventId }) }).catch(console.error);
    document.dispatchEvent(new CustomEvent('fixture-event', { detail: data }));
  };
};
</script>`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

export async function withFixture({ key, cert }, run) {
  const log = [];
  const sockets = new Set();
  const channels = new Set();
  const history = [];
  let proxyRejected = 0;
  let connection = 0;
  function observe(type, value = {}) {
    const record = { type, at: performance.now(), ...value };
    log.push(record);
    return record;
  }
  const server = createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, 'https://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(page);
    } else if (req.method === 'GET' && url.pathname === '/sse') {
      const lastEventId = req.headers['last-event-id'] ?? null;
      const after = url.searchParams.get('after');
      const cursor = Number(lastEventId ?? after ?? history.length);
      const id = ++connection;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write('retry: 1000\n\n');
      const channel = {
        send(event) {
          res.write('id: ' + event.id + '\ndata: ' + JSON.stringify(event) + '\n\n');
        },
        drop: () => res.destroy(),
      };
      channels.add(channel);
      observe('connected', { connection: id, lastEventId, after, cursor });
      res.once('close', () => {
        channels.delete(channel);
        observe('disconnected', { connection: id });
      });
      for (const event of history.slice(cursor)) channel.send(event);
    } else if (req.method === 'POST' && ['/seen', '/delivery', '/content', '/host-exit'].includes(url.pathname)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        observe(url.pathname.slice(1), { value: JSON.parse(Buffer.concat(chunks)) });
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    } else {
      res.writeHead(404).end();
    }
  });
  const proxy = createProxy((_, res) => {
    proxyRejected++;
    res.writeHead(403).end();
  });
  proxy.on('connect', (_, socket) => {
    proxyRejected++;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy());
  });
  for (const listener of [server, proxy]) {
    listener.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  function emit(phase, worker) {
    const event = { id: history.length + 1, phase };
    history.push(event);
    const entry = observe('emitted', { ...event, worker, connections: channels.size });
    for (const channel of channels) channel.send(event);
    return entry;
  }
  try {
    const origin = 'https://127.0.0.1:' + await listen(server);
    const denyProxy = 'http://127.0.0.1:' + await listen(proxy);
    return await run({
      origin, denyProxy, log, observe, emit, proxyRejected: () => proxyRejected,
      connections: () => channels.size,
      drop() {
        observe('drop', { connections: channels.size });
        for (const channel of channels) channel.drop();
      },
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([server, proxy].map(listener => new Promise(resolve => listener.close(resolve))));
  }
}
