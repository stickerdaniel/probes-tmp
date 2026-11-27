# Unary RPC over child pipes

The probe selects a line handler on `serde_json`. The native `jsonrpsee` 0.26.2 response gave the Effect caller a schema defect for a typed refusal. Adding `error._tag: "Cause"` to the serialized response recovered the typed refusal on all three systems.

One reading of “carries the handler” includes a library that parses and dispatches the request while the application rewrites its refusal frame. The core with that rewrite passed all six cases. This verdict uses the reading that the core must also emit the typed refusal through its response path. The native response failed that case. The line handler emitted the accepted frame directly.

## Run

GitHub Actions run `46068152464` tested commit `d021f609bb783e2cfe1f90d30bcad0505dcc7b48`. Each runner recorded 23 trials and 6 injected faults for each of three handler modes. The three runners returned byte-identical `cases.jsonl` files with 87 records each. The SHA-256 of the records was `d1de73ea150ffeb2ba012b482ccb617eab8500151d196d44937ccb287ff5f687`.

The Rust process started Bun as its child. The child called the four unary methods over its stdin and stdout. Effect 4.1.5 uses `RpcSerialization.layerNdJsonRpc()` in `src/rpc/RpcSerialization.ts:702`. The serializer composes JSON-RPC 2.0 with its LF framing at line 297 and uses its incremental UTF-8 parser at line 185.

| System | Handler | 1 Success | 2 Refusal | 3 Optional and nullable | 4 Reverse | 5 Loss | 6 Invalid replies |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ubuntu 24.04 x64 | serde_json line handler | Pass | Typed refusal | All forms | Pass | Pass | Pass |
| Ubuntu 24.04 x64 | jsonrpsee native | Pass | Schema defect | Typed errors lost | Pass | Pass | Pass |
| Ubuntu 24.04 x64 | jsonrpsee with rewrite | Pass | Typed refusal | All forms | Pass | Pass | Pass |
| macOS 15 arm64 | serde_json line handler | Pass | Typed refusal | All forms | Pass | Pass | Pass |
| macOS 15 arm64 | jsonrpsee native | Pass | Schema defect | Typed errors lost | Pass | Pass | Pass |
| macOS 15 arm64 | jsonrpsee with rewrite | Pass | Typed refusal | All forms | Pass | Pass | Pass |
| Windows Server 2025 x64 | serde_json line handler | Pass | Typed refusal | All forms | Pass | Pass | Pass |
| Windows Server 2025 x64 | jsonrpsee native | Pass | Schema defect | Typed errors lost | Pass | Pass | Pass |
| Windows Server 2025 x64 | jsonrpsee with rewrite | Pass | Typed refusal | All forms | Pass | Pass | Pass |

## Observations and wrong variants

| Case | Observation | Fault that tripped the assertion |
| --- | --- | --- |
| 1. Success | Each of the four methods returned its planned result. The handler recorded every method and parameter object. The caller recovered the result under the original numeric id. | Change the result boolean of `autostart.show`. |
| 2. Refusal | An ordinary error object produced a `SchemaError` defect. The marked frame returned `SettingRefused { reason: "locked" }` with the original id. The native core emitted the ordinary object in both trials. The rewrite added the marker to the same native response. | Remove the marker from a marked refusal. For the native-core observation, inject the marker and confirm that the expected schema defect disappears. |
| 3. Optional and nullable | Absent optional strings and present strings round-tripped. Explicit null round-tripped for the required nullable field. All handlers rejected raw optional null and raw nullable absence with code `-32602`. Effect also rejected those inputs before dispatch and rejected the equivalent invalid results and failures. The native core lost the tags and fields of four valid typed refusals here. The other two modes recovered them. | Replace an absent optional result field with null. |
| 4. Reverse | The handler received both ids before writing either reply. The caller observed the second reply first. Each fiber recovered its own result. | Write the replies in request order. |
| 5. Loss | The handler dispatched one request and closed the input pipe before writing an answer. The caller completed once with `RpcClientError` and reason `SocketCloseError`. The handler observed one request and zero reply writes with `Schedule.recurs(0)`. | Deliver the answer instead of closing the pipe. |
| 6. Invalid reply | An extra field and a string in place of a boolean each produced a `SchemaError` defect on the affected call. The other pending call succeeded. With the checking protocol, both pending calls completed with `RpcClientError` and reason `RpcClientDefect`. | Send a schema-valid result and let both pending calls succeed in the checking trial. |

The document lists `params: []` for `autostart.show`. Effect sends `"params":null` in its request. The generator maps the empty descriptor to a null schema and emits `AutostartShowParams(pub ())`. The line handler takes null directly from its request envelope. The core reads the same frame through `raw_json_request`, then `Params::parse` supplies the null value. Both decode that value into the generated unit type. The generated optional string uses `Option<String>`. The shared callback rejects explicit null before decoding that field.

## Refusal bytes

The line handler emitted this frame. Every frame shown ends with an LF byte after the closing brace.

```json
{"jsonrpc":"2.0","id":0,"error":{"_tag":"Cause","code":0,"message":"[{\"_tag\":\"Fail\",\"error\":{\"_tag\":\"SettingRefused\",\"reason\":\"locked\"}}]","data":[{"_tag":"Fail","error":{"_tag":"SettingRefused","reason":"locked"}}]}}
```

The plain line-handler trial and the native core emitted these same bytes. Effect treated the whole error object as the typed error value and raised a schema defect.

```json
{"jsonrpc":"2.0","id":0,"error":{"code":0,"message":"[{\"_tag\":\"Fail\",\"error\":{\"_tag\":\"SettingRefused\",\"reason\":\"locked\"}}]","data":[{"_tag":"Fail","error":{"_tag":"SettingRefused","reason":"locked"}}]}}
```

The core rewrite emitted this frame. Effect recovered the same typed refusal and request id.

```json
{"error":{"_tag":"Cause","code":0,"data":[{"_tag":"Fail","error":{"_tag":"SettingRefused","reason":"locked"}}],"message":"[{\"_tag\":\"Fail\",\"error\":{\"_tag\":\"SettingRefused\",\"reason\":\"locked\"}}]"},"id":0,"jsonrpc":"2.0"}
```

## Handler code

- The [line response wrapper](src/handler.rs#L169-L183) uses 15 lines. Its [response types and error constructors](src/handler.rs#L40-L83) use 44 lines. The wrapper dispatches to the shared typed callback and writes the result or marked refusal directly.
- The [core adapter](src/handler.rs#L185-L232) uses 48 lines for the runtime, method registrations, and calls to `raw_json_request`. The core owns request parsing, method selection, and response ids. Its native `ErrorObjectOwned` owns the initial error envelope and typed cause data.
- The [core extension](src/handler.rs#L234-L242) uses 9 lines and is [called after core serialization](src/main.rs#L100-L109). It parses the serialized response, inserts `_tag: "Cause"` for application error code 0, and reserializes it. Standard invalid-parameter errors keep their original bytes. The output refusal bypasses the core's typed error serializer at the pipe boundary.
- Both adapters use the same [generated-type callback](src/handler.rs#L95-L146) and [pipe driver](src/main.rs#L60). The driver holds replies to control ordering and records dispatches independently of writes.

## Offline regeneration

| System | Effect exports | Typify 0.10.1 byte comparison | Typify 0.10.2 byte comparison |
| --- | --- | --- | --- |
| Ubuntu 24.04 x64 | Pass | Identical | Not run |
| macOS 15 arm64 | Pass | Identical | Not run |
| Windows Server 2025 x64 | Pass | Identical | Not run |

All three Typify 0.10.1 outputs matched the checked-in Rust module. Its SHA-256 is `74588d49c6f5f3d14816d851d6e99dcf52d5087e3d69f74ab70473a8ddfb8da8`. The generator reads parameter and result roots from OpenRPC and named cause arrays from Draft 7. It runs after a locked fetch and uses a locked offline build. The generator executable reads embedded inputs and writes Rust bytes to stdout.

Typify 0.10.1 was the newest eligible release at the start. Typify 0.10.2 reaches the release-age minimum at 2026-11-28 20:18:22.694 UTC. That regeneration row is open. After that time, change [the Typify pin](Cargo.toml#L16), refresh the lockfile with a targeted update, and run the same workflow once. Keep the checked-in generated bytes for the comparison.

## Pins

| Tool or crate | Version | Release date in UTC |
| --- | --- | --- |
| Bun | 1.4.3 | 2026-10-10 |
| Rust | 1.99.1 | 2026-10-16 |
| Effect | 4.1.5 | 2026-11-20 |
| Typify | 0.10.1 | 2026-11-16 |
| jsonrpsee core and types | 0.26.2 | 2026-11-18 |
| serde_json | 1.0.154 | 2026-10-11 |
| serde | 1.0.229 | 2026-07-18 |
| tokio | 1.54.1 | 2026-10-21 |
| prettyplease | 0.2.37 | 2025-08-19 |
| schemars | 0.8.22 | 2025-02-25 |
| syn | 2.0.119 | 2026-07-15 |

Cargo resolved the lockfile with its three-day minimum publish age. Bun installed with its frozen lockfile and scripts disabled.

## Reproduce

Run from this directory with the pinned tools.

```sh
bun install --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org
bun exports.ts --check
cargo fetch --locked
cargo build --locked --offline --bins
mkdir -p results
target/debug/generate > results/generated.rs
cmp src/generated.rs results/generated.rs
bun run.ts > results/cases.jsonl
```

Use `target/debug/generate.exe` on Windows. The workflow uploads the regenerated module, checksums, platform log, and cases.
