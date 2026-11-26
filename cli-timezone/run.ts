import { mkdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join, resolve } from "node:path";

const source = import.meta.dir;
const output = resolve(source, "..", ".probe-output");
const resultFile = process.env.PROBE_RESULT_FILE ?? join(output, "result.json");
const exe = process.platform === "win32" ? ".exe" : "";
const flags = [
  "--compile-autoload-package-json",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--compile-exec-argv=--no-install",
];
const env = { ...process.env, NO_COLOR: "1" };
delete env.PROBE_CWD_VALUE;
delete env.FORCE_COLOR;

function run(
  command: string[],
  cwd: string,
  options: { label?: string[]; environment?: typeof env; timeout?: number } = {}
) {
  const started = performance.now();
  const label = options.label ?? command;
  try {
    const result = Bun.spawnSync(command, {
      cwd,
      env: options.environment ?? env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeout ?? 30000,
    });
    return {
      command: label,
      exit: result.exitCode,
      signal: result.signalCode ?? null,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    return {
      command: label,
      exit: null,
      signal: null,
      stdout: "",
      stderr: String(error),
      elapsedMs: performance.now() - started,
    };
  }
}

mkdirSync(output, { recursive: true });
const empty = join(output, "cwd-empty");
const planted = join(output, "cwd-planted");
const badPackage = join(output, "cwd-package-diagnostic");
const badBunfig = join(output, "cwd-bunfig-diagnostic");
for (const path of [empty, planted, badPackage, badBunfig]) mkdirSync(path, { recursive: true });

writeFileSync(join(planted, ".env"), "PROBE_CWD_VALUE=fixture\n");
writeFileSync(join(planted, "bunfig.toml"), 'logLevel = "warn"\n');
writeFileSync(join(planted, "package.json"), JSON.stringify({
  name: "probe-fixture",
  type: "module",
  imports: { "#metadata": null },
  trustedDependencies: [],
  main: "./absent.js",
}));
writeFileSync(join(badPackage, "package.json"), '{"name":\n');
writeFileSync(join(badBunfig, "bunfig.toml"), "logLevel = [\n");

const help = run(["bun", "build", "--help"], source);
const listedFlags = Object.fromEntries(flags.map((flag) => {
  const name = flag.split("=")[0];
  return [flag, help.stdout.split("\n").some((line) => line.trim().startsWith(name + " ")) ||
    help.stdout.includes(name + "=<val>")];
}));

function binary(name: string) {
  return join(output, name + exe);
}

function build(entry: string, name: string, settings: string[] = flags) {
  const args = ["bun", "build", entry, "--compile", ...settings, "--outfile"];
  const result = run([...args, binary(name)], source, {
    label: [...args, name + exe],
    timeout: 150000,
  });
  console.log(JSON.stringify({ build: name, exit: result.exit, stdout: result.stdout, stderr: result.stderr }));
  return result;
}

const builds = {
  probe: build("cli.ts", "probe"),
  baseline: build("baseline.ts", "baseline"),
  control: build("cli.ts", "control", []),
  timezone: build("timezone.ts", "timezone"),
};

type BinaryName = keyof typeof builds;
function execute(name: BinaryName, args: string[], cwd = empty, environment = env) {
  if (builds[name].exit !== 0) return null;
  return run([binary(name), ...args], cwd, { label: [name + exe, ...args], environment });
}

function size(name: BinaryName) {
  return builds[name].exit === 0 ? statSync(binary(name)).size : null;
}

const probeBytes = size("probe");
const baselineBytes = size("baseline");
const p1 = {
  row1: execute("probe", ["item", "show", "--count", "7"]),
  row2: execute("probe", ["item", "decode", "--config", '{"server":{"port":8080,"tags":["x","y"]}}']),
  row3: {
    missing: execute("probe", ["item", "show"]),
    invalid: execute("probe", ["item", "decode", "--config", '{"server":{"port":"8080","tags":["x"]}}']),
  },
  row4: {
    root: execute("probe", ["--help"]),
    subcommand: execute("probe", ["item", "decode", "--help"]),
  },
  row5: {
    probeBytes,
    baselineBytes,
    delta: probeBytes !== null && baselineBytes !== null ? probeBytes - baselineBytes : null,
  },
  row6: builds.probe.exit === 0
    ? Array.from({ length: 20 }, () => execute("probe", ["--help"]))
    : [],
  row7: Object.fromEntries([
    ["empty", empty], ["planted", planted], ["packageDiagnostic", badPackage], ["bunfigDiagnostic", badBunfig],
  ].map(([name, cwd]) => [
    name, { flagged: execute("probe", ["environment"], cwd), control: execute("control", ["environment"], cwd) },
  ])),
};

const tzVariables = [undefined, "UTC", "Asia/Tokyo"];
const p2 = tzVariables.map((value) => {
  const environment = { ...env };
  delete environment.TZ;
  if (value !== undefined) environment.TZ = value;
  return {
    requestedTZ: value ?? null,
    rows: execute("timezone", ["rows"], empty, environment),
    metadata: execute("timezone", ["metadata"], empty, environment),
  };
});

function hostZone() {
  if (process.platform === "win32") return run(["tzutil", "/g"], source);
  try {
    return readlinkSync("/etc/localtime");
  } catch {
    return null;
  }
}

function measureHostZone() {
  if (process.env.RUNNER_ENVIRONMENT !== "github-hosted" || builds.timezone.exit !== 0) return null;
  const before = hostZone();
  let set: string[];
  let reset: string[];
  if (process.platform === "win32" && typeof before === "object" && before?.exit === 0) {
    set = ["tzutil", "/s", "Tokyo Standard Time"];
    reset = ["tzutil", "/s", before.stdout.trim()];
  } else if (process.platform === "darwin" && typeof before === "string" && before.includes("/zoneinfo/")) {
    set = ["sudo", "-n", "systemsetup", "-settimezone", "Asia/Tokyo"];
    reset = ["sudo", "-n", "systemsetup", "-settimezone", before.split("/zoneinfo/")[1]];
  } else if (process.platform === "linux" && typeof before === "string") {
    set = ["sudo", "-n", "ln", "-sfn", "/usr/share/zoneinfo/Asia/Tokyo", "/etc/localtime"];
    reset = ["sudo", "-n", "ln", "-sfn", before, "/etc/localtime"];
  } else {
    return null;
  }

  const environment = { ...env };
  delete environment.TZ;
  const changed = run(set, source);
  try {
    return {
      before,
      changed,
      after: hostZone(),
      measurements: changed.exit === 0 ? {
        rows: execute("timezone", ["rows"], empty, environment),
        metadata: execute("timezone", ["metadata"], empty, environment),
      } : null,
      reset: run(reset, source),
      restored: hostZone(),
    };
  } catch (error) {
    run(reset, source);
    throw error;
  }
}

function traceConfigFiles() {
  if (process.platform !== "linux" || builds.probe.exit !== 0 || builds.control.exit !== 0) return null;
  const strace = join(output, "strace", "usr", "bin", "strace");
  const files = ["package.json", "bunfig.toml", ".env"].flatMap((file) => ["-P", join(planted, file)]);
  const trace = (name: "probe" | "control") =>
    run([strace, "-qq", "-f", "-e", "trace=%file", ...files, binary(name), "environment"], planted);
  return { version: run([strace, "--version"], source), flagged: trace("probe"), control: trace("control") };
}

const linkage = builds.timezone.exit !== 0 || process.platform === "win32" ? null :
  process.platform === "darwin" ? run(["otool", "-L", binary("timezone")], source) :
    run(["ldd", binary("timezone")], source);

const nativeTzVersion = builds.timezone.exit === 0 && process.platform !== "darwin"
  ? await embeddedTzVersion(binary("timezone"))
  : null;

async function embeddedTzVersion(path: string) {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  const key = "TZVersion\0";
  const matches = [];
  for (let start = bytes.indexOf(key); start !== -1; start = bytes.indexOf(key, start + key.length)) {
    const nearby = bytes.subarray(Math.max(0, start - 2048), Math.min(bytes.length, start + 2048));
    for (const alignment of [0, 1]) {
      for (const match of nearby.subarray(alignment).toString("utf16le").matchAll(/20\d\d[a-z]\x00/g)) {
        matches.push({ version: match[0].slice(0, -1), byteDistance: 2 * match.index + alignment - 2048 });
      }
    }
  }
  return matches;
}

const result = {
  system: {
    platform: process.platform,
    architecture: process.arch,
    release: release(),
    runnerOS: process.env.RUNNER_OS ?? null,
    runnerImage: process.env.ImageOS ?? null,
    runnerImageVersion: process.env.ImageVersion ?? null,
    hostZone: hostZone(),
  },
  bun: run(["bun", "--revision"], source),
  effect: (await import("effect/package.json")).default.version,
  platformBun: (await Bun.file(join(source, "node_modules", "@effect", "platform-bun", "package.json")).json()).version,
  help,
  listedFlags,
  builds,
  p1,
  p2,
  linkage,
  nativeTzVersion,
  hostZoneChange: measureHostZone(),
  configTrace: traceConfigFiles(),
};
writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ platform: result.system.platform, architecture: result.system.architecture, row5: p1.row5 }));
if (Object.values(builds).some(({ exit }) => exit !== 0)) process.exitCode = 1;
