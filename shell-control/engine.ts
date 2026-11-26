import assert from "node:assert/strict";
import { appendFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { autostartState, matchesAutostart } from "./state";

type Request = { action: string; value: unknown; window?: string; defer?: boolean };
type Frame = { id: number; ok: true; applied: boolean } |
  { id: number; ok: false; error: { code: string; message: string } };
type Outcome = { kind: "result"; frame: Frame; ms: number } |
  { kind: "closed" | "timeout"; ms: number };

const dir = process.env.PROBE_DIR!;
const mode = process.env.PROBE_MODE;
const executable = process.env.PROBE_EXE!;
const logPath = join(dir, "engine.jsonl");
const pending = new Map<number, (outcome: Outcome) => void>();
let nextId = 0;

function log(event: Record<string, unknown>) {
  appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
}

function send(line: string) {
  writeSync(1, line + "\n");
}

function request(input: Request, trace = true) {
  const id = ++nextId;
  const starting = performance.now();
  return new Promise<Outcome>((resolve) => {
    const finish = (outcome: Outcome) => {
      clearTimeout(deadline);
      pending.delete(id);
      if (trace) log({ event: "settled", id, ...outcome });
      resolve(outcome);
    };
    const deadline = setTimeout(() => finish({ kind: "timeout", ms: performance.now() - starting }), 8000);
    pending.set(id, (outcome) => finish({ ...outcome, ms: performance.now() - starting }));
    if (trace) log({ event: "request", id, ...input });
    send("control " + JSON.stringify({ id, ...input }));
  });
}

async function receive() {
  let problem: unknown;
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      assert.ok(line.startsWith("result "), line);
      const frame = JSON.parse(line.slice("result ".length)) as Frame;
      const finish = pending.get(frame.id);
      assert.ok(finish, `Unexpected result id ${frame.id}`);
      finish({ kind: "result", frame, ms: 0 });
    }
  } catch (error) {
    problem = error;
  } finally {
    log({ event: "channel_closed", pending: [...pending.keys()], error: problem && String(problem) });
    for (const finish of pending.values()) finish({ kind: "closed", ms: 0 });
  }
}

function applied(outcome: Outcome, value: boolean) {
  return outcome.kind === "result" && outcome.frame.ok && outcome.frame.applied === value;
}

function refused(outcome: Outcome, code: string) {
  return outcome.kind === "result" && !outcome.frame.ok && outcome.frame.error.code === code;
}

async function normal() {
  for (const value of [true, false]) {
    const result = await request({ action: "autostart", value });
    const independent = autostartState();
    log({ event: "effect_autostart", value, result, independent,
      holds: applied(result, value) && matchesAutostart(independent, value, executable) });
  }

  const enabled = await request({ action: "close-to-background", value: true });
  send("fixture close");

  const closeObserved = Bun.file(join(dir, "close-observed"));
  const deadline = performance.now() + 8000;
  while (!(await closeObserved.exists())) {
    assert.ok(performance.now() < deadline, "Runner did not observe the close attempt");
    await Bun.sleep(10);
  }

  const order: Array<{ caller: string; outcome: Outcome }> = [];
  const a = request({ action: "autostart", value: false, defer: true }).then((outcome) => {
    order.push({ caller: "first", outcome });
    return outcome;
  });
  const b = request({ action: "close-to-background", value: true }).then((outcome) => {
    order.push({ caller: "second", outcome });
    return outcome;
  });
  const [first, second] = await Promise.all([a, b]);
  log({ event: "reverse", order, holds: order[0]?.caller === "second" && applied(first, false) && applied(second, true) });

  const samples: number[] = [];
  const failures: Outcome[] = [];
  for (let i = 0; i < 20; i++) {
    const value = i % 2 === 0;
    const result = await request({ action: "autostart", value }, false);
    if (applied(result, value)) samples.push(result.ms);
    else failures.push(result);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const medianMs = sorted.length === 20 ? (sorted[9]! + sorted[10]!) / 2 : null;
  log({ event: "latency", samples, failures, medianMs, holds: medianMs !== null });
  const reset = await request({ action: "close-to-background", value: false });
  log({ event: "effect_close", enabled, disabled: reset, holds: applied(enabled, true) && applied(reset, false) });

  const initial = autostartState();
  const refusals: Array<[string, Request]> = [
    ["unknown_setting", { action: "unknown", value: true }],
    ["invalid_type", { action: "autostart", value: "true" }],
    ["window_unavailable", { action: "close-to-background", value: true, window: "missing" }],
  ];
  for (const [code, input] of refusals) {
    const result = await request(input);
    const independent = autostartState();
    log({ event: "refusal", code, result, independent,
      holds: refused(result, code) && JSON.stringify(initial) === JSON.stringify(independent) });
  }

  send("fixture close");
}

async function main() {
  log({ event: "start", pid: process.pid, bun: Bun.version, mode });
  const inbound = receive();
  if (mode === "normal") {
    await normal();
    await inbound;
  } else {
    const result = await request({ action: "autostart", value: true });
    log({ event: "interrupted", mode, result });
  }
  log({ event: "end" });
}

try {
  await main();
  process.exit(0);
} catch (error) {
  log({ event: "failure", error: String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
}
