import {
  DefaultIntrinsics,
  type QuickJSContext,
  type QuickJSContextResult,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import fixturePath from "./test262.json" with { type: "file" };
import { load } from "./module";

const removed = [
  "eval", "Proxy", "Reflect", "WeakRef", "FinalizationRegistry", "DataView", "ArrayBuffer",
  "SharedArrayBuffer", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Intl", "console",
  "URL", "TextEncoder", "atob", "structuredClone", "crypto", "Buffer",
];

function outcome(vm: QuickJSContext, result: QuickJSContextResult<QuickJSHandle>) {
  using owned = result;
  const value: unknown = owned.error ? vm.dump(owned.error) : vm.dump(owned.value);
  return owned.error ? { error: value } : { value };
}

function names(vm: QuickJSContext, object: QuickJSHandle) {
  using properties = vm.getOwnPropertyNames(object).unwrap();
  return properties.map(handle => vm.getString(handle)).sort();
}

function remove(vm: QuickJSContext) {
  using reflect = vm.getProp(vm.global, "Reflect");
  using deleteProperty = vm.getProp(reflect, "deleteProperty");
  using object = vm.getProp(vm.global, "Object");
  using prototype = vm.getProp(object, "prototype");
  const entries: [QuickJSHandle, string[]][] = [
    [object, ["setPrototypeOf"]],
    [prototype, ["__proto__"]],
    [vm.global, removed],
  ];
  for (const [target, properties] of entries) {
    for (const name of properties) {
      using key = vm.newString(name);
      const result = outcome(vm, vm.callFunction(deleteProperty, reflect, target, key));
      if (result.value !== true) throw Error(JSON.stringify({ name, result }));
    }
  }
  const globals = names(vm, vm.global);
  return {
    globals, remaining: removed.filter(name => globals.includes(name)),
    setPrototypeOf: names(vm, object).includes("setPrototypeOf"),
    protoSetter: names(vm, prototype).includes("__proto__"),
  };
}

function constructorProbe(vm: QuickJSContext) {
  using fn = vm.getProp(vm.global, "Function");
  using body = vm.newString("return 42");
  using constructed = vm.callFunction(fn, vm.undefined, body);
  return constructed.error
    ? { error: vm.dump(constructed.error) as unknown }
    : outcome(vm, vm.callFunction(constructed.value, vm.undefined));
}

function quietContext(module: Awaited<ReturnType<typeof load>>, evalOn: boolean) {
  return module.newContext({
    intrinsics: { ...DefaultIntrinsics, RegExpCompiler: true, Eval: evalOn, Proxy: false },
  });
}

type Sample = {
  revision: string;
  harness: Record<string, string>;
  tests: { path: string; source: string; includes: string[] }[];
};

const module = await load();
for (const evalOn of [false, true]) {
  using vm = quietContext(module, evalOn);
  const before = names(vm, vm.global);
  const after = remove(vm);
  const sum = outcome(vm, vm.evalCode('"use strict"; 1 + 1'));
  const strictWith = outcome(vm, vm.evalCode('"use strict"; with ({}) {}'));
  console.log(JSON.stringify({
    case: evalOn ? "eval-on-control" : "eval-off",
    evalBefore: before.includes("eval"),
    proxyBefore: before.includes("Proxy"),
    after,
    sum,
    strictWith,
    functionFromSource: constructorProbe(vm),
  }));
}

const sample: Sample = await Bun.file(fixturePath).json();
for (const mode of ["default", "restricted", "eval-off"] as const) {
  const results = [];
  for (const test of sample.tests) {
    using vm = mode === "default" ? module.newContext() : quietContext(module, mode !== "eval-off");
    if (mode !== "default") remove(vm);
    const harness = ["assert.js", "sta.js", ...test.includes].map(name => sample.harness[name]).join("\n");
    using result = vm.evalCode('"use strict";\n' + harness + "\n" + test.source + "\n", test.path);
    results.push({ path: test.path, pass: !result.error, error: result.error ? vm.dump(result.error) : undefined });
  }
  console.log(JSON.stringify({
    case: "test262", mode, revision: sample.revision, pass: results.filter(result => result.pass).length,
    total: results.length, results,
  }));
}
