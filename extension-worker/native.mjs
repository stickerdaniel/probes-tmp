import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const { origin, cert } = JSON.parse(readFileSync(process.env.PROBE_HOST_CONFIG, 'utf8'));
const ca = readFileSync(cert);
const pid = process.pid;

function post(path, value) {
  return new Promise((resolve, reject) => {
    const delivery = request(origin + path, { method: 'POST', ca }, response => {
      response.resume();
      response.once('end', () => response.statusCode === 204 ? resolve() : reject(
        new Error('Native delivery returned ' + response.statusCode),
      ));
    });
    delivery.once('error', reject);
    delivery.setTimeout(5000, () => delivery.destroy(new Error('Native delivery timed out')));
    delivery.end(JSON.stringify({ ...value, pid }));
  });
}

let pending = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE();
    if (length > 65_536) throw new Error('Unexpected native message length');
    if (pending.length < 4 + length) break;
    await post('/delivery', JSON.parse(pending.subarray(4, 4 + length)));
    pending = pending.subarray(4 + length);
  }
}
await post('/host-exit', {});
