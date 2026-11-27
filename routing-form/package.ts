import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const form = process.argv[2];
assert.ok(form === "plain" || form === "kit", "Specify plain or kit");
assert.equal(Bun.version, "1.4.3");

const target = { darwin: "app", linux: "deb", win32: "nsis" }[process.platform];
assert.ok(target, "Unsupported build platform");

function run(program: string, ...args: string[]) {
  console.log("$", program, ...args);
  const child = Bun.spawnSync([program, ...args], { stdout: "inherit", stderr: "inherit" });
  assert.equal(child.exitCode, 0, args.join(" "));
}

function bytes(path: string): number {
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  assert.ok(stat.isDirectory(), path);
  return readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0);
}

run("node", "node_modules/vite/bin/vite.js", "build", "--config", `vite.${form}.config.ts`);
assert.ok(statSync("dist/index.html").isFile());

run(process.execPath, "x", "--no-install", "tauri", "icon", "fixtures/icon.png");
run(process.execPath, "x", "--no-install", "tauri", "build", "--no-sign", "--bundles", target, "--", "--locked");

const build = join("src-tauri", "target", "release", "bundle", target);
const extension = { app: ".app", deb: ".deb", nsis: "-setup.exe" }[target];
const packages = readdirSync(build).filter((name) => name.endsWith(extension));
assert.equal(packages.length, 1, "Expected one package");
const packagePath = join(build, packages[0]);
mkdirSync("results", { recursive: true });
writeFileSync("results/sizes.json", JSON.stringify({
  form,
  target,
  packageBytes: bytes(packagePath),
  interfaceBytes: bytes("dist"),
}, null, 2) + "\n");
