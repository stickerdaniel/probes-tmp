import assert from "node:assert/strict";
import { backends, died, faultFor, trials, type Backend, type Trial } from "./trials";

type Request = { jsonrpc: "2.0"; id: number; method: string; params: unknown };
type Response = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { _tag?: string; code: number } };
type Observation = {
  requests: string[];
  dispatched: { method: string; params: unknown; outcome: string }[];
  native_replies: string[];
  sent: string[];
  rewrites: number;
  caller: { outcomes: unknown[]; order: number[] };
};

const executable = Bun.argv[2] ?? (process.platform === "win32"
  ? "./target/debug/unary-contract.exe"
  : "./target/debug/unary-contract");

async function exchange(backend: Backend, name: string, trial: Trial, fault = false) {
  const settings = {
    backend, name, ...trial, requests: trial.requests ?? trial.calls.length,
    ...(fault ? faultFor(name, backend, trial) : {})
  };
  const child = Bun.spawn([executable, process.execPath], {
    stdin: new Blob([JSON.stringify(settings)]),
    stdout: "pipe",
    stderr: "pipe"
  });
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  assert.equal(status, 0, `${name} on ${backend}: ${err}`);
  return JSON.parse(out) as Observation;
}

function checkCaller(backend: Backend, trial: Trial, observation: Observation) {
  const expected = backend === "core-native" && trial.requireMarker ? [died] : trial.expected;
  assert.deepEqual(observation.caller.outcomes, expected);
  if (trial.order) assert.deepEqual(observation.caller.order, trial.order);
  assert.deepEqual([...observation.caller.order].sort((a, b) => a - b), trial.calls.map((_, index) => index));
}

function checkWire(backend: Backend, trial: Trial, observation: Observation) {
  const sent = observation.sent.map((line) => {
    assert.ok(line.endsWith("\n"));
    return JSON.parse(line) as Response;
  });
  const requests = observation.requests.map((line) => JSON.parse(line) as Request);
  const count = trial.requests ?? trial.calls.length;
  assert.equal(requests.length, count);
  assert.equal(new Set(requests.map(({ id }) => id)).size, count);
  assert.deepEqual(requests.map(({ jsonrpc, method, params, id }) => [jsonrpc, method, params, typeof id]),
    trial.calls.slice(0, count).map(([method, params]) => ["2.0", method, params ?? null, "number"]));
  assert.deepEqual(observation.dispatched, requests.map(({ method, params }, index) => ({
    method, params: index === 0 ? trial.replaceParams ?? params : params,
    outcome: trial.rejectsParams ? "invalid-params" : trial.refuse ? "refusal" : "result"
  })));
  const plannedIds = trial.loss ? [] : requests.slice(0, count - Number(trial.dropLast ?? false)).map(({ id }) => id);
  assert.deepEqual(sent.map(({ id }) => id), trial.reverse ? plannedIds.reverse() : plannedIds);
  assert.ok(sent.every(({ jsonrpc }) => jsonrpc === "2.0"));
  if (trial.rejectsParams) assert.equal(sent[0].error?.code, -32602);
  if (trial.requireMarker) assert.equal(sent[0].error?._tag, backend === "core-native" ? undefined : "Cause");
  if (trial.plain) assert.equal(sent[0].error?._tag, undefined);
  assert.equal(observation.rewrites, backend === "core-rewrite" && trial.refuse && !trial.plain ? 1 : 0);
  assert.equal(observation.native_replies.length, backend === "serde-json" ? 0 : count);
  for (const [index, raw] of observation.native_replies.entries()) {
    const response = JSON.parse(raw) as Response;
    assert.equal(response.id, requests[index].id);
    assert.equal(response.error?._tag, undefined);
  }
}

for (const backend of backends) {
  for (const [name, trial] of Object.entries(trials)) {
    const observation = await exchange(backend, name, trial);
    checkCaller(backend, trial, observation);
    checkWire(backend, trial, observation);
    console.log(JSON.stringify({ backend, row: trial.row, name, observation }));
    if (faultFor(name, backend, trial) === undefined) continue;
    const fault = await exchange(backend, name, trial, true);
    assert.throws(() => checkCaller(backend, trial, fault), { code: "ERR_ASSERTION" });
    console.log(JSON.stringify({ backend, row: trial.row, name, wrongVariant: true, observation: fault }));
  }
}
