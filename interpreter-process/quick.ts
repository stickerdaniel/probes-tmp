import ReleaseSync from "@jitl/quickjs-wasmfile-release-sync";
import wasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { run } from "./rows";
import type { Adapter, Json } from "./types";

function copyToGuest(vm: QuickJSContext, value: Json): QuickJSHandle {
  if (value === null) return vm.null;
  if (typeof value === "boolean") return value ? vm.true : vm.false;
  if (typeof value === "string") return vm.newString(value);
  if (typeof value === "number") return vm.newNumber(value);
  const result = Array.isArray(value) ? vm.newArray() : vm.newObject();
  for (const [key, entry] of Object.entries(value)) {
    using handle = copyToGuest(vm, entry);
    vm.setProp(result, key, handle);
  }
  return result;
}

function makeAdapter(module: QuickJSWASMModule): Adapter {
  return {
    id: "quick",
    create(options = {}, calls) {
      const runtime = module.newRuntime();
      const vm = runtime.newContext();
      let deadline = Infinity;
      if (options.timeoutMs !== undefined) {
        runtime.setInterruptHandler(() => performance.now() >= deadline);
      }
      if (options.memoryBytes !== undefined) runtime.setMemoryLimit(options.memoryBytes);
      const pending = new Set<Promise<void>>();
      if (calls) {
        for (const name of ["read", "write"] as const) {
          using handle = vm.newFunction(name, (arg) => {
            const argCopy: unknown = arg ? vm.dump(arg) : undefined;
            const deferred = vm.newPromise();
            const task = calls[name](argCopy).then(
              value => {
                using result = copyToGuest(vm, value);
                deferred.resolve(result);
              },
              error => {
                using result = vm.newError(String(error));
                deferred.reject(result);
              },
            );
            pending.add(task);
            void task.then(() => pending.delete(task), () => pending.delete(task));
            return deferred.handle;
          });
          vm.setProp(vm.global, name, handle);
        }
      }
      return {
        async evaluate(body, form = "sync") {
          deadline = performance.now() + (options.timeoutMs ?? Infinity);
          const asyncPrefix = form === "async" ? "async " : "";
          using result = vm.evalCode(`(${asyncPrefix}() => { "use strict";\n${body}\n})()`);
          if (result.error) return { ok: false, error: vm.dump(result.error) };
          for (;;) {
            const state = vm.getPromiseState(result.value);
            if (state.type === "fulfilled") {
              const value = state.notAPromise ? vm.dump(state.value) : state.value.consume(vm.dump);
              return { ok: true, value };
            }
            if (state.type === "rejected") return { ok: false, error: state.error.consume(vm.dump) };
            if (runtime.hasPendingJob()) {
              using jobs = runtime.executePendingJobs();
              if (jobs.error) return { ok: false, error: vm.dump(jobs.error) };
            } else if (pending.size) {
              await Promise.race(pending);
            } else {
              return { ok: false, error: { name: "ProbeError", message: "Guest promise has no pending jobs or host calls" } };
            }
          }
        },
        memoryUsage() {
          using usage = runtime.computeMemoryUsage();
          return vm.dump(usage);
        },
        dispose() {
          vm.dispose();
          runtime.dispose();
        },
      };
    },
  };
}

await run(async () => makeAdapter(await newQuickJSWASMModuleFromVariant(
  newVariant(ReleaseSync, { wasmBinary: () => Bun.file(wasmPath).arrayBuffer() }),
)), import.meta.url, "quick");
