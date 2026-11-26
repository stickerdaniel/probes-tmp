import {
  QuickJSAsyncContext,
  newQuickJSAsyncWASMModuleFromVariant,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { memoryBody, view } from "./fixtures";

const mib = 1024 ** 2;
const page = 65_536;
const initial = 256;
const oneAllocation = 'return "x".repeat(128 * 1024 * 1024).length;';
const print = (row: object) => console.log(JSON.stringify(row));

function errorInfo(error: unknown) {
  if (error instanceof Error) {
    const details = { name: error.name, message: error.message };
    if (error instanceof SuppressedError) {
      return { ...details, error: errorInfo(error.error), suppressed: errorInfo(error.suppressed) };
    }
    return details;
  }
  return String(error);
}

async function evaluate(vm: QuickJSContext, body: string) {
  const start = performance.now();
  const source = `(() => { "use strict";\n${body}\n})()`;
  try {
    using result = vm instanceof QuickJSAsyncContext
      ? await vm.evalCodeAsync(source)
      : vm.evalCode(source);
    if (result.error) {
      const error: unknown = vm.dump(result.error);
      return { kind: "guest", error, ms: performance.now() - start };
    }
    const value: unknown = vm.dump(result.value);
    return { kind: "value", value, ms: performance.now() - start };
  } catch (error) {
    return { kind: "host", error: errorInfo(error), ms: performance.now() - start };
  }
}

function countView(value: unknown): number {
  if (
    value === null || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !("children" in value) || !Array.isArray(value.children) ||
    !("type" in value) || typeof value.type !== "string"
  ) {
    throw Error("View contains a value outside the plain node shape");
  }
  return 1 + value.children.reduce<number>((sum, child) => sum + countView(child), 0);
}

function hostAddOne(value: number) {
  return value + 1;
}

function installHost(vm: QuickJSContext) {
  using fn = vm.newFunction("hostAddOne", (value) => vm.newNumber(hostAddOne(vm.getNumber(value))));
  vm.setProp(vm.global, "hostAddOne", fn);
}

async function recover(vm: QuickJSContext) {
  return {
    sum: await evaluate(vm, "return 1 + 1;"),
    hostCall: await evaluate(vm, "return hostAddOne(41);"),
  };
}

async function initialize(
  variant: QuickJSVariant,
  wasmPath: string,
  wasmMemory: WebAssembly.Memory | undefined,
  mapPath: string | undefined,
) {
  const options = {
    wasmBinary: () => Bun.file(wasmPath).arrayBuffer(),
    wasmMemory,
    ...(mapPath === undefined ? {} : { locateFile: (file: string) => file.endsWith(".map") ? mapPath : file }),
  };
  if (variant.type === "async") {
    return newQuickJSAsyncWASMModuleFromVariant(newVariant(variant, options));
  }
  return newQuickJSWASMModuleFromVariant(newVariant(variant, options));
}

async function runWithModule(
  module: QuickJSWASMModule,
  kind: string,
  limitBytes: number,
  fixture: string,
  memory: WebAssembly.Memory | undefined,
  started: number,
  initMs: number,
) {
  const start = performance.now();
  using runtime = module.newRuntime();
  using vm = runtime.newContext();
  if (kind === "native") runtime.setMemoryLimit(limitBytes);

  if (fixture === "view") {
    const createMs = performance.now() - start;
    const render = await evaluate(vm, view);
    if (render.kind !== "value") {
      print({ phase: "view-error", render });
      throw Error("The view fixture failed");
    }
    const nodes = countView(render.value);
    if (nodes !== 200) throw Error(`Expected 200 nodes, got ${nodes}`);
    const now = performance.now();
    print({
      phase: "view", nodes, initMs, createMs, evaluateMs: render.ms,
      instanceAndViewMs: now - start, coldMs: now - started,
      linearBytes: memory?.buffer.byteLength,
    });
    return;
  }

  if (fixture === "growth") {
    if (!memory) throw Error("The growth fixture needs supplied linear memory");
    const before = memory.buffer.byteLength;
    print({ phase: "before", linearBytes: before });
    let error;
    try {
      memory.grow((limitBytes - before) / page + 1);
    } catch (failure) {
      error = errorInfo(failure);
    }
    print({ phase: "growth", linearBytes: memory.buffer.byteLength, error });
    return;
  }

  installHost(vm);
  print({ phase: "before", fixture, limitBytes, linearBytes: memory?.buffer.byteLength });
  const result = await evaluate(vm, fixture === "loop" ? memoryBody : oneAllocation);
  print({ phase: "returned", result, linearBytes: memory?.buffer.byteLength });
  print({ phase: "host", value: hostAddOne(41) });
  const same = await recover(vm);
  print({ phase: "same", ...same });
  using freshRuntime = module.newRuntime();
  using freshVm = freshRuntime.newContext();
  if (kind === "native") freshRuntime.setMemoryLimit(limitBytes);
  installHost(freshVm);
  print({ phase: "fresh", ...await recover(freshVm), linearBytes: memory?.buffer.byteLength });
}

export async function run(variant: QuickJSVariant, wasmPath: string, variantName: string, mapPath?: string) {
  const [kind, amount, fixture] = process.argv.slice(2);
  const limitBytes = Number(amount) * mib;
  if (Bun.version !== "1.4.3") throw Error(`Expected Bun 1.4.3, got ${Bun.version}`);
  if (
    !["baseline", "native", "wasm"].includes(kind) ||
    !["loop", "single", "view", "growth"].includes(fixture) ||
    !(kind === "baseline" ? amount === "0" : ["16", "64"].includes(amount)) ||
    (fixture === "growth" && kind !== "wasm")
  ) throw Error("Expected baseline 0 or native/wasm 16/64, plus loop/single/view/growth");

  const started = performance.now();
  try {
    const memory = kind === "wasm"
      ? new WebAssembly.Memory({ initial, maximum: limitBytes / page })
      : undefined;
    const module = await initialize(variant, wasmPath, memory, mapPath);
    const initMs = performance.now() - started;
    if (fixture !== "view") {
      print({ phase: "loaded", variant: variantName, revision: Bun.revision, initMs });
    }
    await runWithModule(module, kind, limitBytes, fixture, memory, started, initMs);
  } catch (error) {
    print({ phase: "host-error", error: errorInfo(error) });
    process.exitCode = 1;
  }
}
