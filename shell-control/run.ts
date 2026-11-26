import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appId, autostartState, matchesAutostart } from "./state";

const [file, output] = process.argv.slice(2);
assert.ok(file && output, "Usage: bun run.ts <packaged shell executable> <output directory>");
const executable = resolve(file);
const root = resolve(output);
const evidence: Record<string, unknown>[] = [];
mkdirSync(root, { recursive: true });

function record(event: string, details: Record<string, unknown>) {
  const entry = { at: new Date().toISOString(), event, ...details };
  evidence.push(entry);
  console.log(JSON.stringify(entry));
  writeFileSync(join(root, "driver.json"), JSON.stringify(evidence, null, 2) + "\n");
}

function read(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function engineLog(dir: string) {
  const lines = read(join(dir, "engine.jsonl")).split("\n");
  lines.pop();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function start(mode: string) {
  const dir = join(root, mode);
  mkdirSync(dir);
  const logfile = join(dir, "shell.log");
  const fd = openSync(logfile, "w");
  try {
    const shell = Bun.spawn([executable], {
      env: { ...process.env, PROBE_EXE: executable, PROBE_DIR: dir, PROBE_MODE: mode },
      stdout: fd,
      stderr: fd,
    });
    record("shell_start", { mode, pid: shell.pid });
    return { dir, logfile, shell };
  } finally {
    closeSync(fd);
  }
}

function alive(pid: number) {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function wait<T>(read: () => T | undefined, message: string, timeout = 12000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

type Run = ReturnType<typeof start>;

async function stop(run: Run) {
  if (run.shell.exitCode === null && run.shell.signalCode === null) {
    run.shell.kill(9);
    await run.shell.exited;
  }
  const pid = engineLog(run.dir).find((event) => event.event === "start")?.pid;
  if (typeof pid === "number") {
    try {
      await wait(() => alive(pid) ? undefined : true, "Engine still running", 3000);
    } catch {
      if (alive(pid)) process.kill(pid, 9);
      record("engine_stopped", { pid });
    }
  }
}

async function normal() {
  const run = start("normal");
  try {
    const close = await wait(() => /close (prevented|allowed)/.exec(read(run.logfile)) ?? undefined,
      "No close attempt reached the window handler");
    const survived = alive(run.shell.pid);
    record("enabled_close", { decision: close[1], survived, holds: close[1] === "prevented" && survived });
    writeFileSync(join(run.dir, "close-observed"), "observed\n");

    const status = await wait(() => run.shell.exitCode ?? undefined, "Shell stayed alive after final close", 45000);
    const allowed = read(run.logfile).includes("close allowed");
    const exited = !alive(run.shell.pid);
    const independent = autostartState();
    const events = engineLog(run.dir);
    record("disabled_close", { status, allowed, exited, independent, holds: status === 0 && allowed && exited });
    return status === 0 && allowed && exited
      && matchesAutostart(independent, false, executable)
      && ["effect_autostart", "effect_close", "refusal", "reverse", "latency"].every((name) =>
        events.some((event) => event.event === name))
      && events.every((event) => event.holds !== false);
  } finally {
    await stop(run);
  }
}

async function interruption(mode: "before" | "after") {
  const run = start(mode);
  try {
    const marker = await wait(() => new RegExp(`delay ${mode} (\\d+)`).exec(read(run.logfile)) ?? undefined,
      `No delay marker for ${mode}`);
    const killAt = new Date().toISOString();
    const began = performance.now();
    run.shell.kill(9);
    const status = await run.shell.exited;
    const shellExitMs = performance.now() - began;
    const observed = await wait(() => engineLog(run.dir).find((event) => event.event === "interrupted"),
      "Engine did not record its outcome", 9500).catch(() => undefined);
    const independent = autostartState();
    const result = observed?.result as { kind: string } | undefined;
    const holds = (result?.kind === "closed" || result?.kind === "timeout")
      && matchesAutostart(independent, mode === "after", executable);
    record("interruption", { mode, id: Number(marker[1]), killAt, status, shellExitMs,
      result: result ?? null, independent, holds });
    return holds;
  } finally {
    await stop(run);
  }
}

async function cleanup() {
  const run = start("cleanup");
  try {
    const status = await wait(() => run.shell.exitCode ?? undefined, "Cleanup shell did not exit");
    const independent = autostartState();
    record("cleanup", { status, independent, holds: status === 0 && matchesAutostart(independent, false, executable) });
    return status === 0 && matchesAutostart(independent, false, executable);
  } finally {
    await stop(run);
  }
}

const baseline = autostartState();
record("baseline", { os: process.platform, arch: process.arch, bun: Bun.version, appId, independent: baseline });
assert.ok(matchesAutostart(baseline, false, executable), "Existing autostart entry");
let passed = true;
for (const [name, run] of [["normal", normal], ["before", () => interruption("before")],
  ["after", () => interruption("after")], ["cleanup", cleanup]] as const) {
  try {
    passed = (await run()) && passed;
  } catch (error) {
    record("driver_error", { name, error: String(error) });
    passed = false;
  }
}
if (!passed) process.exitCode = 1;
