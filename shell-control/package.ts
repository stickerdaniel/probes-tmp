import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const hosts = {
  "darwin-arm64": ["aarch64-apple-darwin", "app"],
  "darwin-x64": ["x86_64-apple-darwin", "app"],
  "linux-x64": ["x86_64-unknown-linux-gnu", "deb"],
  "win32-x64": ["x86_64-pc-windows-msvc", "nsis"],
} as const;
const host = hosts[`${process.platform}-${process.arch}` as keyof typeof hosts];
assert.ok(host, "Unsupported build host");
const [triple, bundle] = host;
const extension = bundle === "nsis" ? ".exe" : "";

function run(...args: string[]) {
  console.log("$", args.join(" "));
  const child = Bun.spawnSync([process.execPath, ...args], { stdout: "inherit", stderr: "inherit" });
  assert.equal(child.exitCode, 0, args.join(" "));
}

assert.equal(Bun.version, "1.4.3");
mkdirSync("src-tauri/binaries", { recursive: true });
run("x", "--no-install", "tauri", "icon", "ui/icon.png");
run("build", "--compile", "engine.ts", "--outfile", `src-tauri/binaries/probe-engine-${triple}${extension}`);
run("x", "--no-install", "tauri", "build", "--no-sign", "--bundles", bundle, "--", "--locked");
