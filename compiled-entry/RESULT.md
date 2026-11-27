# Entry selection of a compiled Bun executable

GitHub Actions run 46067262482 measured source commit `26752aee0cedeaaf3dfa8e7abb64d671e3e619d8` on `macos-15`, `ubuntu-24.04` and `windows-2025`. The same `probe.ts` ran on a local macOS 27.2.1 arm64 machine. Every system ran Bun 1.4.3, revision `c6da4a4d3010e5553438c60f6bd76d981976867c`. The probe has no dependency outside Bun.

## Result

No candidate switches the runtime's command line off. Every candidate keeps the three modes and the closed bundle check. A guard in the entry never starts under `BUN_BE_BUN=1`.

| System | Candidates | `BUN_BE_BUN=1` reaches the runtime | Modes pass | Bundle check passes | Guard started under `BUN_BE_BUN=1` | `BUN_OPTIONS` preload ran |
| --- | ---: | --- | --- | --- | --- | --- |
| Local macOS 27.2.1 arm64 | 6 | 5 of 5 arguments, every candidate | 6 of 6 | 6 of 6 | 0 of 5 arguments | 6 of 6 |
| GitHub macOS 15 arm64 | 6 | 5 of 5 arguments, every candidate | 6 of 6 | 6 of 6 | 0 of 5 arguments | 6 of 6 |
| GitHub Ubuntu 24.04 x64 | 6 | 5 of 5 arguments, every candidate | 6 of 6 | 6 of 6 | 0 of 5 arguments | 6 of 6 |
| GitHub Windows Server 2025 x64 | 6 | 5 of 5 arguments, every candidate | 6 of 6 | 6 of 6 | 0 of 5 arguments | 6 of 6 |

## Program

`entry.ts` is a stand-in with three modes, `serve`, `relay` and `check`, selected by its first argument. It prints `entry:<mode>`. It prints `entry:version` for `--version` and `entry:other:<arguments>` with exit code 64 for anything else. `guard.ts` prints `guard:started` to stderr. It exits with 65 when `BUN_BE_BUN` or `BUN_OPTIONS` is set, and it imports `entry.ts` otherwise.

The bundle check reads the metafile of `bun build --compile`. It fails on every external import that is neither a Node builtin nor `bun` nor `bun:*`.

## Candidates

| Name | Entry | Flags |
| --- | --- | --- |
| control | `entry.ts` | `--compile-autoload-package-json --no-compile-autoload-dotenv --no-compile-autoload-bunfig --compile-exec-argv=--no-install` |
| every-autoload-off | `entry.ts` | `--no-compile-autoload-package-json --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --compile-exec-argv=--no-install` |
| exec-argv-no-env-file | `entry.ts` | control autoload flags, `--compile-exec-argv=--no-install --no-env-file` |
| exec-argv-strict-strings | `entry.ts` | control autoload flags, `--compile-exec-argv=--no-install --disallow-code-generation-from-strings=strict` |
| exec-argv-no-addons | `entry.ts` | control autoload flags, `--compile-exec-argv=--no-install --no-addons --no-ffi-cc` |
| entry-guard | `guard.ts` | control flags |

`bun build --help` of 1.4.3 lists no flag about the entry selection. The other `--compile-*` flags set autoloading, the executable path for cross-compilation, the JIT policy, the bytecode order and Windows metadata.

## Rows per candidate

Each candidate ran these rows on each system. The runtime's command line ran in every `BUN_BE_BUN=1` row on every system and candidate.

| Row | Environment | Start directory | Observed with `BUN_BE_BUN=1` | Observed without it |
| --- | --- | --- | --- | --- |
| `--version` | `BUN_BE_BUN=1` | fixtures | stdout `1.4.3`, exit 0 | `entry:version` |
| `run script.ts` | `BUN_BE_BUN=1` | fixtures | stdout `script:ran 1.4.3`, exit 0 | `entry:other:run script.ts`, exit 64 |
| `-e 'console.log("eval:" + 6 * 7)'` | `BUN_BE_BUN=1` | fixtures | stdout `eval:42`, exit 0 | `entry:other:...`, exit 64 |
| `x --no-install compiled-entry-absent-bin` | `BUN_BE_BUN=1` | fixtures | bunx error `Could not find an existing 'compiled-entry-absent-bin' binary to run`, exit 1 | `entry:other:...`, exit 64 |
| `install` | `BUN_BE_BUN=1` | empty | `bun install` error `Bun could not find a package.json file to install from`, exit 1 | `entry:other:install`, exit 64 |
| `--version` | `BUN_BE_BUN=true` and `yes` | fixtures | stdout `1.4.3` | |
| `--version` | `BUN_BE_BUN=0` and `false` | fixtures | `entry:version` in five candidates, the guard refused with exit 65 in `entry-guard` | |
| `serve` | `BUN_OPTIONS=--preload ./pre.ts` | fixtures | stderr `preload:ran`, then the program | no `preload:ran` |

The registry was `http://127.0.0.1:9/` in every row, so `x` and `install` used no network. `x` ran with `--no-install`.

The guard row: under `BUN_BE_BUN=1`, stderr held no `guard:started` in any of the five arguments. Under `BUN_OPTIONS=--preload ./pre.ts`, stderr read `preload:ran`, `guard:started`, `guard:refused`, in that order, with exit code 65.

## Wrong variants

| Case | Variant | Result on every system |
| --- | --- | --- |
| Bundle check | `open-bundle.ts` imports a missing package inside `try` | Flagged, `compiled-entry-missing-fixture` |
| Modes | Each mode checked against the next mode's output | Failed, 3 of 3 per candidate |
| Runtime detection | Each of the five arguments without `BUN_BE_BUN` | Classified as the program, 5 of 5 per candidate |
| Preload | `serve` without `BUN_OPTIONS` | No `preload:ran` |
| Guard | `ENTRY_PROBE_FORCE_GUARD=1` without `BUN_BE_BUN` | `guard:started`, `guard:refused`, exit 65 |

Three faults planted on the local machine made the probe report a failure. A mode that printed the wrong name failed the control and exited 1. An entry that printed Bun's version for `--version` classified the row without `BUN_BE_BUN` as the runtime and set `consistent` to false. An unresolved import inside `try` in the entry failed the bundle check of the control and exited 1.

## Source read

The Bun 1.4.3 tag, commit `c6da4a4d3010e5553438c60f6bd76d981976867c`:

- `src/runtime/cli/mod.rs:1202-1209`: `start` reads `BUN_BE_BUN` and loads the embedded graph only when the variable is false. No flag of the graph is read before this branch.
- `src/bun_core/env_var.rs:227` declares `BUN_BE_BUN` as a feature flag. `src/bun_core/env_var.rs:424-430` treats every value as true except the empty string, `0`, `false`, `no` and `off`.
- `src/standalone_graph/StandaloneModuleGraph.rs:907-912`: the graph flags are the four autoload switches and layout bits. None names the entry selection.
- `src/bun_core/util.rs:3745-3749` splices `BUN_OPTIONS` into argv. `src/runtime/cli/mod.rs:1355-1360` keeps those tokens in a compiled executable.
- `docs/bundler/executables.mdx:516` documents `BUN_BE_BUN`. `docs/bundler/executables.mdx:429-441` documents `BUN_OPTIONS` for compiled executables.
- `docs/runtime/code-generation-from-strings.mdx:200-201`: `--preload` in `BUN_OPTIONS` loads a file before the entry point, and with `BUN_BE_BUN=1` the embedded flags do not apply.
- `src/runtime/cli/mod.rs:1178-1183` reads `BUN_INTERNAL_WEBVIEW_HOST` on macOS before `BUN_BE_BUN` and hands the process to the WebView host, with no JavaScript runtime after it. The probe did not measure it.
