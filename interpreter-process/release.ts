import variant from "@jitl/quickjs-wasmfile-release-sync";
import wasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import { run } from "./probe";

await run(variant, wasmPath, "quickjs-wasmfile-release-sync");
