# Compiler diagnostic probe

Keep TypeScript 6.0.3 as the type checker. The release-age rule blocked `@effect/tsgo` 0.73.7. The language service 0.87.5 caught the three Effect faults on each stand-in runner.

## Versions

| Package or runtime | Version | Registry release (UTC) |
| --- | --- | --- |
| Bun | 1.4.3 | 2026-10-10 05:31:17 |
| TypeScript | 6.0.3 | 2026-04-16 23:38:27 |
| Effect | 4.1.5 | 2026-11-20 09:16:56 |
| Effect language service | 0.87.5 | 2026-10-16 17:21:04 |
| Effect compiler | 0.73.7 | 2026-11-26 07:43:14 |
| Native TypeScript | 7.0.2 | 2026-07-08 15:55:18 |
| `@types/bun` | 1.4.3 | 2026-10-12 08:04:42 |
| `bun-types` | 1.4.3 | 2026-10-10 05:29:43 |
| `@types/node`, stand-in | 26.6.7 | 2026-11-24 19:34:51 |
| `undici-types`, stand-in | 8.13.1 | 2026-11-20 21:01:47 |
| `undici-types`, via Node types | 8.9.0 | 2026-07-24 12:32:56 |

`typescript@7.0.2` supplies Microsoft's native compiler. The `@effect/tsgo` README lists a `tsc@7.0.2` build. Version 0.73.7 reaches 72 hours on 2026-11-29 at 07:43:14 UTC.

The matrix ran at `ac50f0221520de26db58007a7d6ab38edd20119d` in Actions run 46067129153. The stand-in passed on the Linux VM before the push.

## Planted variants

| Fault | One edit |
| --- | --- |
| Ordinary engine error | Assign a string to a number. |
| Ordinary portable error | Return a string from a number-returning function. |
| Ordinary tooling error | Return a string from a function that returns a compiler syntax kind. |
| Dropped Effect | Add a standalone `Effect.log` statement. |
| Missing service | Remove the layer provision from the effect passed to `runPromise`. |
| Sibling layer | Replace explicit layer provision with `Layer.mergeAll`. |
| Clean | Compile the original files. |

Each fault changed one source file. The runner restored its original bytes after checking it. Each timing uses a fresh process. The repeat followed the first run with the same source. The runner kept filesystem caches in place. macOS and Linux supplied peak child RSS. The Windows run did not supply peak RSS.

The stock count comes from `tsc --listFilesOnly`. The source count excludes compiler libraries, dependencies and JSON. The language service reports its own `filesChecked` count and emits Effect diagnostics only. The exit column records the checker process status.

## Stand-in results

### ubuntu-24.04

`Linux-7.0.0-1018-aws-x86_64-with-glibc2.39`, Bun 1.4.3, Node v22.23.5.
The TypeScript API boundary check exited 0 in 0.136 s.

**engine**. Stock TypeScript loaded 464 files, including 1 workspace TypeScript file. The language service scanned 1 source file.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 5.473 / 1.084 | 291504 / 294020 |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 1.661 / 1.429 | 427484 / 403224 |
| Ordinary engine error | tsc 6.0.3 | `engine/main.ts:11` | Yes | TS2322 (D1) at `engine/main.ts:11` | 2 | 1.113 / 1.101 | 292760 / 293820 |
| Ordinary engine error | Language service 0.87.5 | `engine/main.ts:11` | No | None | 0 | 1.448 / 1.650 | 404380 / 408028 |
| Dropped Effect | tsc 6.0.3 | `engine/main.ts:12` | No | None | 0 | 1.282 / 1.101 | 290124 / 293048 |
| Dropped Effect | Language service 0.87.5 | `engine/main.ts:12` | Yes | Effect 3 `floatingEffect` (D2) at `engine/main.ts:12` | 1 | 1.442 / 1.434 | 405448 / 404408 |
| Missing service | tsc 6.0.3 | `engine/main.ts:12` | Yes | TS2345 (D3) at `engine/main.ts:12` | 2 | 1.104 / 1.131 | 291724 / 294324 |
| Missing service | Language service 0.87.5 | `engine/main.ts:12` | Yes | Effect 1 `missingEffectContext` (D4) at `engine/main.ts:12` | 1 | 1.437 / 1.418 | 403808 / 403268 |
| Sibling layer | tsc 6.0.3 | `engine/main.ts:8` | No | TS2345 (D5) at `engine/main.ts:12` | 2 | 1.118 / 1.137 | 294864 / 296416 |
| Sibling layer | Language service 0.87.5 | `engine/main.ts:8` | Yes | Effect 1 `missingEffectContext` (D6) at `engine/main.ts:12`<br>Effect 37 `layerMergeAllWithDependencies` (D7) at `engine/main.ts:8` | 1 | 1.436 / 1.456 | 401112 / 400896 |

**portable**. Stock TypeScript loaded 88 files, including 1 workspace TypeScript file. The language service scanned 1 source file.
The portable program loaded zero Bun or Node declarations.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 0.213 / 0.216 | 100232 / 100120 |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 0.406 / 0.389 | 130028 / 128472 |
| Ordinary portable error | tsc 6.0.3 | `portable/frame.ts:1` | Yes | TS2322 (D1) at `portable/frame.ts:1` | 2 | 0.215 / 0.215 | 100652 / 101756 |
| Ordinary portable error | Language service 0.87.5 | `portable/frame.ts:1` | No | None | 0 | 0.392 / 0.392 | 127864 / 127032 |

**tooling**. Stock TypeScript loaded 289 files, including 1 workspace TypeScript file. The language service scanned 1 source file.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 0.612 / 0.635 | 196936 / 196156 |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 0.948 / 0.906 | 267908 / 263080 |
| Ordinary tooling error | tsc 6.0.3 | `tooling/boundaries.ts:5` | Yes | TS2322 (D8) at `tooling/boundaries.ts:5` | 2 | 0.634 / 0.619 | 195324 / 195852 |
| Ordinary tooling error | Language service 0.87.5 | `tooling/boundaries.ts:5` | No | None | 0 | 0.938 / 0.927 | 258904 / 258984 |

### windows-2025

`Windows-2025Server-10.0.26100-SP0`, Bun 1.4.3, Node v22.23.5.
The TypeScript API boundary check exited 0 in 0.157 s.

**engine**. Stock TypeScript loaded 464 files, including 1 workspace TypeScript file. The language service scanned 1 source file.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 5.541 / 1.566 | Unavailable |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 2.358 / 2.198 | Unavailable |
| Ordinary engine error | tsc 6.0.3 | `engine/main.ts:11` | Yes | TS2322 (D1) at `engine/main.ts:11` | 2 | 1.673 / 1.531 | Unavailable |
| Ordinary engine error | Language service 0.87.5 | `engine/main.ts:11` | No | None | 0 | 2.001 / 1.950 | Unavailable |
| Dropped Effect | tsc 6.0.3 | `engine/main.ts:12` | No | None | 0 | 1.516 / 1.532 | Unavailable |
| Dropped Effect | Language service 0.87.5 | `engine/main.ts:12` | Yes | Effect 3 `floatingEffect` (D2) at `engine/main.ts:12` | 1 | 1.943 / 1.954 | Unavailable |
| Missing service | tsc 6.0.3 | `engine/main.ts:12` | Yes | TS2345 (D3) at `engine/main.ts:12` | 2 | 1.529 / 1.538 | Unavailable |
| Missing service | Language service 0.87.5 | `engine/main.ts:12` | Yes | Effect 1 `missingEffectContext` (D4) at `engine/main.ts:12` | 1 | 1.961 / 1.978 | Unavailable |
| Sibling layer | tsc 6.0.3 | `engine/main.ts:8` | No | TS2345 (D5) at `engine/main.ts:12` | 2 | 1.547 / 1.542 | Unavailable |
| Sibling layer | Language service 0.87.5 | `engine/main.ts:8` | Yes | Effect 1 `missingEffectContext` (D6) at `engine/main.ts:12`<br>Effect 37 `layerMergeAllWithDependencies` (D7) at `engine/main.ts:8` | 1 | 1.960 / 1.939 | Unavailable |

**portable**. Stock TypeScript loaded 88 files, including 1 workspace TypeScript file. The language service scanned 1 source file.
The portable program loaded zero Bun or Node declarations.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 0.328 / 0.352 | Unavailable |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 0.516 / 0.520 | Unavailable |
| Ordinary portable error | tsc 6.0.3 | `portable/frame.ts:1` | Yes | TS2322 (D1) at `portable/frame.ts:1` | 2 | 0.357 / 0.357 | Unavailable |
| Ordinary portable error | Language service 0.87.5 | `portable/frame.ts:1` | No | None | 0 | 0.511 / 0.510 | Unavailable |

**tooling**. Stock TypeScript loaded 289 files, including 1 workspace TypeScript file. The language service scanned 1 source file.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 0.967 / 0.998 | Unavailable |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 1.446 / 1.332 | Unavailable |
| Ordinary tooling error | tsc 6.0.3 | `tooling/boundaries.ts:5` | Yes | TS2322 (D8) at `tooling/boundaries.ts:5` | 2 | 0.891 / 0.902 | Unavailable |
| Ordinary tooling error | Language service 0.87.5 | `tooling/boundaries.ts:5` | No | None | 0 | 1.250 / 1.243 | Unavailable |

### macos-15

`macOS-15.8.2-arm64-arm-64bit-Mach-O`, Bun 1.4.3, Node v22.23.5.
The TypeScript API boundary check exited 0 in 0.147 s.

**engine**. Stock TypeScript loaded 464 files, including 1 workspace TypeScript file. The language service scanned 1 source file.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 1.786 / 1.047 | 302320 / 291872 |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 1.401 / 1.207 | 416560 / 383888 |
| Ordinary engine error | tsc 6.0.3 | `engine/main.ts:11` | Yes | TS2322 (D1) at `engine/main.ts:11` | 2 | 1.006 / 1.358 | 293168 / 295552 |
| Ordinary engine error | Language service 0.87.5 | `engine/main.ts:11` | No | None | 0 | 1.298 / 1.301 | 383184 / 382640 |
| Dropped Effect | tsc 6.0.3 | `engine/main.ts:12` | No | None | 0 | 1.107 / 1.180 | 290048 / 291392 |
| Dropped Effect | Language service 0.87.5 | `engine/main.ts:12` | Yes | Effect 3 `floatingEffect` (D2) at `engine/main.ts:12` | 1 | 1.354 / 1.338 | 388864 / 388832 |
| Missing service | tsc 6.0.3 | `engine/main.ts:12` | Yes | TS2345 (D3) at `engine/main.ts:12` | 2 | 1.171 / 1.059 | 292496 / 292176 |
| Missing service | Language service 0.87.5 | `engine/main.ts:12` | Yes | Effect 1 `missingEffectContext` (D4) at `engine/main.ts:12` | 1 | 1.591 / 1.427 | 387936 / 386064 |
| Sibling layer | tsc 6.0.3 | `engine/main.ts:8` | No | TS2345 (D5) at `engine/main.ts:12` | 2 | 1.244 / 1.155 | 294784 / 293216 |
| Sibling layer | Language service 0.87.5 | `engine/main.ts:8` | Yes | Effect 1 `missingEffectContext` (D6) at `engine/main.ts:12`<br>Effect 37 `layerMergeAllWithDependencies` (D7) at `engine/main.ts:8` | 1 | 1.563 / 1.626 | 380944 / 382912 |

**portable**. Stock TypeScript loaded 88 files, including 1 workspace TypeScript file. The language service scanned 1 source file.
The portable program loaded zero Bun or Node declarations.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 0.331 / 0.315 | 98976 / 103840 |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 0.428 / 0.478 | 127072 / 127296 |
| Ordinary portable error | tsc 6.0.3 | `portable/frame.ts:1` | Yes | TS2322 (D1) at `portable/frame.ts:1` | 2 | 0.334 / 0.285 | 98512 / 95936 |
| Ordinary portable error | Language service 0.87.5 | `portable/frame.ts:1` | No | None | 0 | 0.351 / 0.371 | 127168 / 125024 |

**tooling**. Stock TypeScript loaded 289 files, including 1 workspace TypeScript file. The language service scanned 1 source file.

| Fault | Checker | Edit | At edit | Diagnostics | Exit | First / repeat (s) | First / repeat peak (KiB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| Clean | tsc 6.0.3 | None | N/A | None | 0 | 0.806 / 0.720 | 187968 / 188864 |
| Clean | Language service 0.87.5 | None | N/A | None | 0 | 0.880 / 0.853 | 250752 / 256352 |
| Ordinary tooling error | tsc 6.0.3 | `tooling/boundaries.ts:5` | Yes | TS2322 (D8) at `tooling/boundaries.ts:5` | 2 | 0.663 / 0.959 | 189472 / 187936 |
| Ordinary tooling error | Language service 0.87.5 | `tooling/boundaries.ts:5` | No | None | 0 | 1.327 / 1.208 | 255328 / 251376 |

### Diagnostic messages

| ID | Code | Message |
| --- | --- | --- |
| D1 | TS2322 | Type 'string' is not assignable to type 'number'. |
| D2 | Effect 3 `floatingEffect` | This Effect value is neither yielded nor used in an assignment. |
| D3 | TS2345 | Argument of type 'Effect<number, never, Output>' is not assignable to parameter of type 'Effect<number, never, never>'.<br>Type 'Output' is not assignable to type 'never'. |
| D4 | Effect 1 `missingEffectContext` | This Effect requires a service that is missing from the expected Effect context: `Output`. |
| D5 | TS2345 | Argument of type 'Effect<number, never, Input>' is not assignable to parameter of type 'Effect<number, never, never>'.<br>Type 'Input' is not assignable to type 'never'. |
| D6 | Effect 1 `missingEffectContext` | This Effect requires a service that is missing from the expected Effect context: `Input`. |
| D7 | Effect 37 `layerMergeAllWithDependencies` | This layer provides Input which is required by another layer in the same Layer.mergeAll call. Layer.mergeAll creates layers in parallel, so dependencies between layers will not be satisfied. Consider moving this layer into a Layer.provideMerge after the Layer.mergeAll. |
| D8 | TS2322 | Type '"wrong"' is not assignable to type 'SyntaxKind'. |

## Rows not run

| Systems | Checker | Rows | Reason |
| --- | --- | --- | --- |
| Ubuntu 24.04, Windows 2025, macOS 15 | `@effect/tsgo` 0.73.7 on native TypeScript 7.0.2 | Three clean controls and six faults on each runner | Version 0.73.7 was under 72 hours old. |
