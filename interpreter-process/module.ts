import ReleaseSync from "@jitl/quickjs-wasmfile-release-sync";
import wasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";

export function load(wasmMemory?: WebAssembly.Memory) {
  return newQuickJSWASMModuleFromVariant(
    newVariant(ReleaseSync, { wasmBinary: () => Bun.file(wasmPath).arrayBuffer(), wasmMemory }),
  );
}
