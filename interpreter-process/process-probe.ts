import { EventEmitter } from "node:events";
import { load } from "./module";

const mib = 1024 ** 2;
const stepBytes = 8 * mib;
const steps = 48;

type Frame = {
  kind: string;
  id?: number;
  value?: number;
  app?: string;
  attemptedBytes?: number;
  allocatedBytes?: number;
  error?: string;
};

const emit = (value: unknown) => console.log(JSON.stringify(value));
const encoded = (value: unknown) => JSON.stringify(value) + "\n";

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        yield pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    if (pending) throw Error("Partial frame at EOF");
  } finally {
    reader.releaseLock();
  }
}

async function worker(app: string) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 1024 });
  const module = await load(memory);
  using vm = module.newContext();
  using ready = vm.evalCode("1 + 1");
  if (ready.error) throw Error(JSON.stringify(vm.dump(ready.error)));
  emit({ kind: "ready", app, value: vm.getNumber(ready.value), linearBytes: memory.buffer.byteLength });
  const allocations: Buffer[] = [];
  for await (const line of lines(Bun.stdin.stream())) {
    const message: Frame = JSON.parse(line);
    if (message.kind === "stop") return;
    if (message.kind === "event") {
      using result = vm.evalCode(JSON.stringify(message.value) + " * 2");
      if (result.error) throw Error(JSON.stringify(vm.dump(result.error)));
      emit({ kind: "result", id: message.id, value: vm.getNumber(result.value), app });
    }
    if (message.kind === "pending") {
      emit({ kind: "call", id: message.id, value: 41, app });
    }
    if (message.kind === "reply") {
      emit({ kind: "result", id: message.id, value: message.value, app });
    }
    if (message.kind === "grow") {
      for (let index = 0; index < steps; index++) {
        const attemptedBytes = (index + 1) * stepBytes;
        try {
          allocations.push(Buffer.alloc(stepBytes, 0x5a));
        } catch (error) {
          emit({ kind: "allocation-error", attemptedBytes, error: String(error) });
          break;
        }
        emit({ kind: "allocated", allocatedBytes: attemptedBytes });
        await Bun.sleep(8);
      }
      emit({ kind: "growth-done", allocatedBytes: allocations.length * stepBytes });
    }
  }
}

function launch(app: string) {
  const started = performance.now();
  const env = process.platform === "win32"
    ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
    : {};
  const child = Bun.spawn([process.execPath, "worker", app], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit", env, windowsHide: true,
  });
  const frames: Frame[] = [];
  let eofMs: number | undefined;
  const ready = Promise.withResolvers<{ frame: Frame; elapsedMs: number }>();
  const received = (async () => {
    for await (const line of lines(child.stdout)) {
      const frame: Frame = JSON.parse(line);
      frames.push(frame);
      if (frame.kind === "ready") ready.resolve({ frame, elapsedMs: performance.now() - started });
    }
    eofMs = performance.now() - started;
    ready.reject(Error("Worker closed stdout before ready"));
  })();
  void received.catch(error => ready.reject(error));
  return {
    child, ready: ready.promise, frames, received,
    send(message: Frame) {
      child.stdin.write(encoded(message));
      child.stdin.flush();
    },
    async until(kind: string) {
      for (;;) {
        const frame = frames.find(candidate => candidate.kind === kind);
        if (frame) return frame;
        if (eofMs !== undefined) throw Error("Worker closed stdout before " + kind);
        await Bun.sleep(1);
      }
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await received;
      return { code: child.exitCode, signal: child.signalCode, eofMs };
    },
  };
}

type Sample = { rssBytes: number; peakBytes?: number; privateBytes?: number; virtualBytes?: number };
type MonitorReply = { samples?: Sample[]; limit?: object; error?: string };

function monitor(python: string, script: string) {
  const child = Bun.spawn([python, script, "monitor"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const replies = lines(child.stdout);
  return {
    async call(op: string, pids: number[]): Promise<MonitorReply> {
      child.stdin.write(encoded({ op, pids }));
      child.stdin.flush();
      const line = await replies.next();
      if (line.done) throw Error("OS monitor closed stdout");
      return JSON.parse(line.value);
    },
    async close() {
      child.stdin.end();
      await child.exited;
    },
  };
}

async function parent(row: string, python: string, script: string) {
  const workers: ReturnType<typeof launch>[] = [];
  const start = (app: string) => {
    const instance = launch(app);
    workers.push(instance);
    return instance;
  };
  const observer = monitor(python, script);
  const sample = async (instances: typeof workers) => {
    const result = await observer.call("sample", instances.map(instance => instance.child.pid));
    if (!result.samples) throw Error(result.error ?? "Missing RSS samples");
    return result.samples;
  };
  try {
    if (row === "start") {
      const times = [];
      for (let trial = 0; trial < 9; trial++) {
        const instance = start("worker-a");
        const ready = await instance.ready;
        if (ready.frame.value !== 2) throw Error("Worker initialization failed");
        times.push(ready.elapsedMs);
        instance.send({ kind: "stop" });
        if (await instance.child.exited !== 0) throw Error("Worker exit failed");
      }
      emit({ row, times, medianMs: times.toSorted((a, b) => a - b)[4] });
    } else if (row === "rss") {
      const one = start("worker-a");
      await one.ready;
      await Bun.sleep(120);
      const single = await sample([one]);
      const others = ["worker-b", "worker-c", "worker-d"].map(start);
      await Promise.all(others.map(instance => instance.ready));
      await Bun.sleep(120);
      const four = await sample(workers);
      emit({ row, single, four, totalBytes: four.reduce((sum, entry) => sum + entry.rssBytes, 0) });
    } else if (row === "watch" || row === "os-limit" || row === "control") {
      const worker = start("worker-a");
      const { frame } = await worker.ready;
      const before = (await sample([worker]))[0];
      const limit = row === "os-limit"
        ? await observer.call("limit", [worker.child.pid])
        : undefined;
      if (limit && !limit.limit) {
        emit({ row, before, limit });
        return;
      }
      worker.send({ kind: "grow" });
      const samples = [];
      let killed = false;
      let sampledPeakBytes = 0;
      for (;;) {
        const rss = (await sample([worker]))[0];
        samples.push(rss);
        sampledPeakBytes = Math.max(sampledPeakBytes, rss.rssBytes);
        if (row === "watch" && rss.rssBytes > 256 * mib) {
          worker.child.kill("SIGKILL");
          killed = true;
          break;
        }
        if (worker.child.exitCode !== null || worker.child.signalCode !== null ||
            worker.frames.some(frame => frame.kind === "growth-done")) break;
        await Bun.sleep(3);
      }
      const allocated = worker.frames.filter(frame => frame.kind === "allocated").at(-1);
      const error = worker.frames.find(frame => frame.kind === "allocation-error");
      const done = worker.frames.find(frame => frame.kind === "growth-done");
      const kernelPeak = row === "os-limit" ? await observer.call("peak", [worker.child.pid]) : undefined;
      if (done) {
        worker.send({ kind: "stop" });
        await worker.child.exited;
      }
      const exit = await worker.close();
      let replacement;
      if (row === "watch" && killed) {
        const next = start("worker-a");
        const ready = await next.ready;
        replacement = { ...ready, pidChanged: next.child.pid !== worker.child.pid };
      }
      emit({ row, before, frame, limit, samples, sampledPeakBytes, killed, allocated, error, done, kernelPeak, exit, replacement });
    } else if (row === "pending") {
      const worker = start("worker-a");
      await worker.ready;
      worker.send({ kind: "pending", id: 1 });
      const request = await worker.until("call");
      const hostCall = new AbortController();
      const aborted = new Promise<boolean>(resolve => {
        hostCall.signal.addEventListener("abort", () => resolve(true), { once: true });
      });
      const killedAt = performance.now();
      const exit = await worker.close();
      hostCall.abort();
      const observedMs = performance.now() - killedAt;
      const replacement = start("worker-a");
      await replacement.ready;
      replacement.send({ kind: "event", id: 2, value: 21 });
      const result = await replacement.until("result");
      emit({
        row, request, pendingAtKill: 1, repliesSent: 0, hostCallAborted: await aborted,
        resultsFromKilledWorker: worker.frames.filter(frame => frame.kind === "result").length,
        eof: exit.eofMs !== undefined, exit, observedMs, replacementResult: result,
      });
    } else if (row === "event") {
      const events = new EventEmitter();
      const workersBefore = workers.length;
      const result = await new Promise<Frame>((resolve, reject) => {
        events.once("event", (value: number) => {
          void (async () => {
            const worker = start("worker-a");
            await worker.ready;
            worker.send({ kind: "event", id: 1, value });
            return worker.until("result");
          })().then(resolve, reject);
        });
        setTimeout(() => events.emit("event", 21), 20);
      });
      emit({ row, windowsCreated: 0, workersBefore, workersAfter: workers.length, result });
    } else {
      throw Error("Unknown process row " + row);
    }
  } finally {
    try {
      await Promise.all(workers.map(instance => instance.close()));
    } finally {
      await observer.close();
    }
  }
}

const [mode, first, second, third] = process.argv.slice(2);
if (mode === "worker") await worker(first);
else if (mode === "parent") await parent(first, second, third);
else throw Error("Expected parent or worker");
