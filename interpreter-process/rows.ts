import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { arrayMethods, asyncLoopBody, language, loopBody, memoryBody, regexBody, view } from "./fixtures";
import type { Adapter, Initialize, Engine, Form, HostCalls, Result } from "./types";

const timeoutMs = 100;
const memoryBytes = 16 * 1024 * 1024;
const isolationDelayMs = 10;
const formatMs = (ms: number) => Number(ms.toFixed(3));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const resultValue = (result: Result) => result.ok ? result.value : undefined;
const print = (value: unknown) => console.log(JSON.stringify(value));
const sumScript = "return 1 + 1;";

function errorInfo(error: unknown): unknown {
  if (error instanceof Error) {
    return { class: error.constructor.name, name: error.name, message: error.message };
  }
  return error;
}

async function timed(engine: Engine, body: string, form: Form = "sync") {
  const start = performance.now();
  let result: Result;
  try {
    result = await engine.evaluate(body, form);
  } catch (error) {
    result = { ok: false, error: errorInfo(error) };
  }
  return { ms: formatMs(performance.now() - start), result };
}

const plain = (arg: unknown) => {
  if (arg === null || typeof arg !== "object") return String(typeof arg);
  const proto: unknown = Object.getPrototypeOf(arg);
  if (proto === Object.prototype) return "Object.prototype";
  if (proto === Array.prototype) return "Array.prototype";
  return proto === null ? "null" : "other";
};

async function limits(adapter: Adapter, mode: string) {
  const options = mode === "memory" && adapter.id === "quick" ? { memoryBytes } : { timeoutMs };
  const engine = adapter.create(options);
  const sampler = process.env.PROBE_RSS_HANDSHAKE === "1" ? Bun.stdin.stream().getReader() : undefined;
  try {
    const fixtures = {
      loop: [loopBody, "sync"],
      async: [asyncLoopBody, "async"],
      regex: [regexBody, "sync"],
      memory: [memoryBody, "sync"],
    } as const;
    if (!(mode in fixtures)) throw Error(`Unknown limit case ${mode}`);
    const [body, form] = fixtures[mode as keyof typeof fixtures];
    print({ phase: "before", mode, options });
    await sampler?.read();
    const test = await timed(engine, body, form);
    print({ phase: "returned", ...test });
    await sampler?.read();
    const same = await timed(engine, sumScript);
    const other = adapter.create(options);
    try {
      print({ phase: "recovery", same, fresh: await timed(other, sumScript) });
    } finally {
      other.dispose();
    }
  } finally {
    await sampler?.cancel();
    engine.dispose();
  }
}

async function memoryDiagnostics(adapter: Adapter) {
  const engine = adapter.create({ memoryBytes });
  try {
    const before = engine.memoryUsage?.();
    const fixture = memoryBody.replace("const data = []", "const data = globalThis.probeData = []")
      .replace("while (true)", "while (i < 4096)") + " return data.length;";
    const allocation = await timed(engine, fixture);
    const after = engine.memoryUsage?.();
    print({ memoryBytes, before, allocation, after });
  } finally {
    engine.dispose();
  }
}

async function globals(adapter: Adapter) {
  const data = { label: "host", nested: { count: 7 }, items: [1, 2] };
  const engine = adapter.create({}, { read: async () => data, write: async () => null });
  const names = ["Bun", "console", "fetch", "globalThis", "process", "require", "setTimeout"];
  const typeMap = (keys: string[]) => keys.map(key => `"${key}": typeof ${key}`).join(", ");
  try {
    const types = await engine.evaluate(`return { ${typeMap(names)} };`);
    const visible = await engine.evaluate(adapter.globalNames
      ? `return { ${typeMap([...adapter.globalNames, "read", "write"])} };`
      : "return Object.getOwnPropertyNames(globalThis).sort();");
    const dataCheck = await engine.evaluate(`
      const data = await read({ kind: "data" });
      const proto = Object.getPrototypeOf(data);
      const nestedProto = Object.getPrototypeOf(data.nested);
      data.label = "guest";
      data.nested.count = 8;
      data.items.push(3);
      return {
        objectProto: proto === Object.prototype ? "Object.prototype" : proto === null ? "null" : "other",
        nestedProto: nestedProto === Object.prototype ? "Object.prototype" : nestedProto === null ? "null" : "other",
        arrayProto: Object.getPrototypeOf(data.items) === Array.prototype,
        guest: data,
      };
    `, "async");
    const hostImport = await engine.evaluate(`
      try {
        const module = await import("read");
        return { resolved: true, type: typeof module, defaultType: typeof module.default };
      } catch (error) {
        return { resolved: false, name: error.name, message: error.message };
      }
    `, "async");
    const absentImport = await engine.evaluate(`
      try {
        await import("probe-not-provided");
        return { resolved: true };
      } catch (error) {
        return { resolved: false, name: error.name, message: error.message };
      }
    `, "async");
    const requireRead = await engine.evaluate(`
      if (typeof require !== "function") return null;
      return typeof require("read");
    `);
    print({ types, visible, dataCheck, unchangedHostData: data, hostImport, absentImport, requireRead });
  } finally {
    engine.dispose();
  }
}

async function hostCalls(adapter: Adapter, mode: string) {
  const concurrency = mode === "concurrent" ? 100 : 1;
  const count = concurrency === 100 ? 100 : 1000;
  const argumentsSeen = { total: 0, valid: 0, read: 0, write: 0, peakInflight: 0, shapes: new Set<string>() };
  let inflight = 0;
  const gate = Promise.withResolvers<void>();
  const checkedCall = (name: keyof HostCalls) => async (arg: unknown) => {
    argumentsSeen.total++;
    argumentsSeen[name]++;
    const i = argumentsSeen.total - 1;
    if (typeof arg === "object" && arg !== null && "nested" in arg && "items" in arg && "i" in arg) {
      const shape = [plain(arg), plain(arg.nested), plain(arg.items)].join(" / ");
      argumentsSeen.shapes.add(shape);
      if (isDeepStrictEqual(arg, { i, nested: { kind: name }, items: [i, true] })) argumentsSeen.valid++;
    }
    inflight++;
    argumentsSeen.peakInflight = Math.max(argumentsSeen.peakInflight, inflight);
    if (concurrency === 100) {
      if (argumentsSeen.total === concurrency) gate.resolve();
      await gate.promise;
    } else {
      await Promise.resolve();
    }
    inflight--;
    return { i: typeof arg === "object" && arg !== null && "i" in arg && typeof arg.i === "number" ? arg.i : -1 };
  };
  const engine = adapter.create({}, { read: checkedCall("read"), write: checkedCall("write") });
  const gateDeadline = setTimeout(() => gate.resolve(), 250);
  try {
    const start = `
      function call(i) {
        const name = i % 2 ? "write" : "read";
        const args = { i, nested: { kind: name }, items: [i, true] };
        return i % 2 ? write(args) : read(args);
      }
    `;
    const code = concurrency === 100
      ? start + `const promises = []; for (let i = 0; i < ${count}; i++) promises.push(call(i));
        const results = await Promise.all(promises);
        return results.every((result, i) => result.i === i);`
      : start + `for (let i = 0; i < ${count}; i++) { if ((await call(i)).i !== i) return false; } return true;`;
    const test = await timed(engine, code, "async");
    print({ mode, count, ...test, argumentsSeen: { ...argumentsSeen, shapes: [...argumentsSeen.shapes] } });
  } finally {
    clearTimeout(gateDeadline);
    engine.dispose();
  }
}

const markerCheck = 'return typeof globalThis === "object" ? typeof globalThis.probeMarker : typeof Array.probeMarker;';
const markerSet = `
  const marker = typeof globalThis === "object" ? globalThis : Array;
  marker.probeMarker = 73;
  return { value: marker.probeMarker, target: marker === Array ? "Array" : "globalThis" };
`;

async function mainInstances(adapter: Adapter) {
  const first = adapter.create({ timeoutMs });
  const second = adapter.create({ timeoutMs });
  try {
    const set = await first.evaluate(markerSet);
    const ownNext = await first.evaluate(markerCheck);
    const other = await second.evaluate(markerCheck);
    const runTimer = async () => {
      const scheduled = now();
      await Bun.sleep(isolationDelayMs);
      const entered = now();
      const reply = await timed(second, sumScript);
      return { timerLatenessMs: formatMs(entered - scheduled - isolationDelayMs),
        responseMs: formatMs(now() - scheduled), reply };
    };
    const idle = await runTimer();
    const request = runTimer();
    const [slow, overlap] = await Promise.all([timed(first, loopBody), request]);
    print({ set, ownNext, other, idle, slow, overlap });
  } finally {
    first.dispose();
    second.dispose();
  }
}

type WorkerCommand = { id: number; body: string };
type WorkerReply =
  | { id: 0; kind: "ready" }
  | { id: number; kind: "start" }
  | { id: number; kind: "done"; value: Awaited<ReturnType<typeof timed>> };

async function workerMain(initialize: Initialize) {
  const adapter = await initialize();
  const engine = adapter.create({ timeoutMs });
  self.onmessage = async ({ data }: MessageEvent<WorkerCommand>) => {
    const { id, body } = data;
    const start: WorkerReply = { id, kind: "start" };
    self.postMessage(start);
    const value = await timed(engine, body);
    const done: WorkerReply = { id, kind: "done", value };
    self.postMessage(done);
  };
  const ready: WorkerReply = { id: 0, kind: "ready" };
  self.postMessage(ready);
}

function workerClient(url: string) {
  const worker = new Worker(url);
  type Receipt = WorkerReply & { received: number };
  const replies = new Map<string, ReturnType<typeof Promise.withResolvers<Receipt>>>();
  let workerError: Error | undefined;
  let id = 0;
  const wait = (id: number, kind: WorkerReply["kind"]) => {
    if (workerError) return Promise.reject(workerError);
    const slot = Promise.withResolvers<Receipt>();
    replies.set(`${id}:${kind}`, slot);
    return slot.promise;
  };
  const ready = wait(0, "ready");
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    const key = `${data.id}:${data.kind}`;
    replies.get(key)?.resolve({ ...data, received: now() });
    replies.delete(key);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    workerError = new Error(event.message);
    for (const slot of replies.values()) slot.reject(workerError);
    replies.clear();
  };
  return {
    worker,
    ready,
    request(body: string) {
      const requestId = ++id;
      const start = wait(requestId, "start") as Promise<Extract<Receipt, { kind: "start" }>>;
      const done = wait(requestId, "done") as Promise<Extract<Receipt, { kind: "done" }>>;
      const sent = now();
      worker.postMessage({ id: requestId, body } satisfies WorkerCommand);
      return { start, done, sent };
    },
  };
}

async function workers(url: string) {
  const first = workerClient(url);
  let second: ReturnType<typeof workerClient> | undefined;
  const deadline = setTimeout(() => {
    print({ error: "Worker message deadline elapsed" });
    process.exit(3);
  }, 2_500);
  try {
    second = workerClient(url);
    await Promise.all([first.ready, second.ready]);
    const mark = first.request(markerSet);
    await mark.start;
    const set = (await mark.done).value;
    const isolate = second.request(markerCheck);
    await isolate.start;
    const other = (await isolate.done).value;
    const idle = second.request(sumScript);
    const [idleStart, idleDone] = await Promise.all([idle.start, idle.done]);
    const slow = first.request(loopBody);
    const slowStart = await slow.start;
    await Bun.sleep(isolationDelayMs);
    const light = second.request(sumScript);
    const [lightStart, lightDone, slowDone] = await Promise.all([light.start, light.done, slow.done]);
    print({ set, other, idle: {
      dispatchMs: formatMs(idleStart.received - idle.sent),
      responseMs: formatMs(idleDone.received - idle.sent), result: idleDone.value,
    }, overlap: {
      dispatchMs: formatMs(lightStart.received - light.sent),
      responseMs: formatMs(lightDone.received - light.sent),
      sentAfterSlowStartMs: formatMs(light.sent - slowStart.received),
      finishedBeforeSlowEndMs: formatMs(slowDone.received - lightDone.received),
      result: lightDone.value,
    }, slow: slowDone.value });
  } finally {
    clearTimeout(deadline);
    first.worker.terminate();
    second?.worker.terminate();
  }
}

function countView(value: unknown): number {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype ||
    !("children" in value) || !Array.isArray(value.children) || !("type" in value) ||
    typeof value.type !== "string") {
    throw Error("View contains a value outside the plain node shape");
  }
  return 1 + value.children.reduce<number>((sum, child) => sum + countView(child), 0);
}

async function startCost(adapter: Adapter, initMs: number) {
  const times = [];
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    const engine = adapter.create();
    const made = performance.now();
    try {
      const value = await engine.evaluate(view);
      const end = performance.now();
      if (!value.ok || countView(value.value) !== 200) throw Error(JSON.stringify(value));
      times.push({ createMs: formatMs(made - start), evaluateMs: formatMs(end - made), totalMs: formatMs(end - start) });
    } finally {
      engine.dispose();
    }
  }
  const warm = times.slice(1).sort((a, b) => a.totalMs - b.totalMs);
  print({ initMs, lines: view.split("\n").length, nodes: 200, cold: times[0],
    warmMedian: warm.slice(9, 11).reduce((total, trial) => total + trial.totalMs, 0) / 2,
    warmMin: warm[0].totalMs, warmMax: warm.at(-1)?.totalMs, warmTrials: warm.length });
}

async function idleMemory(adapter: Adapter, n: number) {
  const engines: Engine[] = [];
  const warm = adapter.create();
  try {
    const result = await warm.evaluate(view);
    if (!result.ok || countView(result.value) !== 200) throw Error(JSON.stringify(result));
  } finally {
    warm.dispose();
  }
  const reader = process.env.PROBE_RSS_HANDSHAKE === "1" ? Bun.stdin.stream().getReader() : undefined;
  const rss = async (phase: string) => {
    Bun.gc(true);
    await Bun.sleep(120);
    print({ phase });
    await reader?.read();
  };
  await rss("idle-before");
  try {
    for (let i = 0; i < n; i++) {
      const engine = adapter.create();
      engines.push(engine);
      const result = await engine.evaluate(view);
      if (!result.ok || countView(result.value) !== 200) throw Error(JSON.stringify(result));
    }
    await rss("idle-after");
    print({ instances: engines.length });
  } finally {
    await reader?.cancel();
    for (const engine of engines.reverse()) engine.dispose();
  }
}

async function coverage(adapter: Adapter) {
  const engine = adapter.create();
  try {
    const checks = {};
    for (const [name, [source, expected]] of Object.entries(language)) {
      const result = await engine.evaluate(source, name === "asyncAwait" ? "async" : "sync");
      Object.assign(checks, { [name]: isDeepStrictEqual(resultValue(result), expected) ? "holds" : result });
    }
    const arrays: Record<string, unknown> = {};
    for (const [name, [source, expected]] of Object.entries(arrayMethods)) {
      const result = await engine.evaluate(`const a = [3, 1, 2]; let sum = 0; return ${source};`);
      arrays[name] = isDeepStrictEqual(resultValue(result), expected) ? "holds" : result;
    }
    print({ checks, arrays });
  } finally {
    engine.dispose();
  }
}

export async function run(initialize: Initialize, url: string, id: string) {
  if (!isMainThread) {
    await workerMain(initialize);
    return;
  }
  if (Bun.version !== "1.4.3") throw Error(`Expected Bun 1.4.3, got ${Bun.version}`);
  const [row = "r1", mode = ""] = process.argv.slice(2);
  if (row === "r6" && mode === "worker") {
    await workers(url);
    return;
  }
  const start = performance.now();
  const adapter = await initialize();
  const initMs = formatMs(performance.now() - start);
  switch (row) {
    case "r1": {
      const engine = adapter.create();
      try {
        print({ bun: Bun.version, revision: Bun.revision, id, initMs, ...await timed(engine, sumScript) });
      } finally {
        engine.dispose();
      }
      break;
    }
    case "r2": await limits(adapter, mode); break;
    case "r3": await limits(adapter, "memory"); break;
    case "r3-usage": await memoryDiagnostics(adapter); break;
    case "r3-output": {
      const engine = adapter.create({ outputBytes: 128 });
      try {
        const result = await engine.evaluate('console.log("x".repeat(2048)); return "x".repeat(2048);');
        print(result);
      } finally {
        engine.dispose();
      }
      break;
    }
    case "r4": await globals(adapter); break;
    case "r5": await hostCalls(adapter, mode); break;
    case "r6": await mainInstances(adapter); break;
    case "r7": {
      if (mode) await idleMemory(adapter, Number(mode));
      else await startCost(adapter, initMs);
      break;
    }
    case "r8": await coverage(adapter); break;
    default: throw Error(`Unknown row ${row}`);
  }
}
