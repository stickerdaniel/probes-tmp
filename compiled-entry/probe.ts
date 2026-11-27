import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const version = "1.4.3";
if (Bun.version !== version) throw new Error(`Expected Bun ${version}, got ${Bun.version}`);

const todayFlags = [
  "--compile-autoload-package-json",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--compile-exec-argv=--no-install",
] as const;
const autoload = todayFlags.slice(0, 3);

type Candidate = { readonly name: string; readonly entry: "entry.ts" | "guard.ts"; readonly flags: readonly string[] };

const candidates: readonly Candidate[] = [
  { name: "control", entry: "entry.ts", flags: todayFlags },
  {
    name: "every-autoload-off",
    entry: "entry.ts",
    flags: [
      "--no-compile-autoload-package-json",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--compile-exec-argv=--no-install",
    ],
  },
  { name: "exec-argv-no-env-file", entry: "entry.ts", flags: [...autoload, "--compile-exec-argv=--no-install --no-env-file"] },
  {
    name: "exec-argv-strict-strings",
    entry: "entry.ts",
    flags: [...autoload, "--compile-exec-argv=--no-install --disallow-code-generation-from-strings=strict"],
  },
  { name: "exec-argv-no-addons", entry: "entry.ts", flags: [...autoload, "--compile-exec-argv=--no-install --no-addons --no-ffi-cc"] },
  { name: "entry-guard", entry: "guard.ts", flags: todayFlags },
];

type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string };
type Ran = "runtime" | "program" | "refused" | "unknown";

const work = await mkdtemp(join(tmpdir(), "compiled-entry-"));
const start = join(work, "start");
const empty = join(work, "empty");
await mkdir(start);
await mkdir(empty);
await Bun.write(join(start, "script.ts"), 'console.log("script:ran", Bun.version);\n');
await Bun.write(join(start, "pre.ts"), 'console.error("preload:ran");\n');

const unreachableRegistry = "http://127.0.0.1:9/";
const baseEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(BUN_|NODE_OPTIONS$|NPM_CONFIG_REGISTRY$|ENTRY_PROBE_)/i.test(entry[0]),
    ),
  ),
  BUN_CONFIG_REGISTRY: unreachableRegistry,
  NPM_CONFIG_REGISTRY: unreachableRegistry,
};

const run = async (args: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Result> => {
  const child = Bun.spawn([...args], {
    cwd: options.cwd ?? start,
    env: { ...baseEnv, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

type Metafile = { readonly inputs: Record<string, { readonly imports: readonly { readonly path: string; readonly external?: boolean }[] }> };

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), "bun"]);
const isBuiltin = (specifier: string) => builtins.has(specifier) || specifier.startsWith("bun:");

const compile = async (entry: string, outfile: string, flags: readonly string[]) => {
  const metafile = `${outfile}.meta.json`;
  const built = await run(
    [process.execPath, "build", "--compile", ...flags, `--metafile=${metafile}`, join(import.meta.dir, entry), "--outfile", outfile],
    { cwd: import.meta.dir },
  );
  if (built.code !== 0) throw new Error(`bun build failed: ${JSON.stringify(built)}`);
  const meta: Metafile = await Bun.file(metafile).json();
  return Object.values(meta.inputs).flatMap((input) =>
    input.imports.filter((entry) => entry.external === true && !isBuiltin(entry.path)).map((entry) => entry.path),
  );
};

const cliCases = [
  { name: "--version", args: ["--version"], cwd: start, runtime: (r: Result) => r.code === 0 && r.stdout === version },
  { name: "run script.ts", args: ["run", "script.ts"], cwd: start, runtime: (r: Result) => r.code === 0 && r.stdout === `script:ran ${version}` },
  { name: "-e", args: ["-e", 'console.log("eval:" + 6 * 7)'], cwd: start, runtime: (r: Result) => r.code === 0 && r.stdout === "eval:42" },
  {
    name: "x --no-install",
    args: ["x", "--no-install", "compiled-entry-absent-bin"],
    cwd: start,
    runtime: (r: Result) => r.code !== 0 && r.stderr.includes("Could not find an existing 'compiled-entry-absent-bin' binary"),
  },
  { name: "install (empty dir)", args: ["install"], cwd: empty, runtime: (r: Result) => r.code !== 0 && r.stderr.includes("could not find a package.json") },
] as const;

const classify = (result: Result, runtime: (r: Result) => boolean): Ran => {
  if (runtime(result)) return "runtime";
  if (result.code === 65 && result.stderr.includes("guard:refused")) return "refused";
  if (result.stdout.startsWith("entry:")) return "program";
  return "unknown";
};

const modeNames = ["serve", "relay", "check"] as const;
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

const measure = async (candidate: Candidate) => {
  const directory = join(work, candidate.name);
  await mkdir(directory);
  const binary = join(directory, exe("stand-in"));
  const unresolved = await compile(candidate.entry, binary, candidate.flags);
  const openUnresolved = await compile("open-bundle.ts", join(directory, exe("open-bundle")), candidate.flags);
  const bundle = { unresolved, passed: unresolved.length === 0, wrongVariant: { openUnresolved, flagged: openUnresolved.includes("compiled-entry-missing-fixture") } };

  const modes = [];
  for (const [index, mode] of modeNames.entries()) {
    const result = await run([binary, mode]);
    const swapped = modeNames[(index + 1) % modeNames.length];
    const passes = (expected: string) => result.code === 0 && result.stdout === `entry:${expected}`;
    modes.push({ mode, result, passed: passes(mode), wrongVariant: { expected: swapped, passed: passes(swapped) } });
  }
  const ownVersion = await run([binary, "--version"]);

  const cli = [];
  for (const cliCase of cliCases) {
    const selected = await run([binary, ...cliCase.args], { cwd: cliCase.cwd, env: { BUN_BE_BUN: "1" } });
    const unselected = await run([binary, ...cliCase.args], { cwd: cliCase.cwd });
    cli.push({
      name: cliCase.name,
      selected: { result: selected, ran: classify(selected, cliCase.runtime), guardStarted: selected.stderr.includes("guard:started") },
      wrongVariant: { result: unselected, ran: classify(unselected, cliCase.runtime) },
    });
  }

  const versionCase = cliCases[0];
  const truthiness = [];
  for (const value of ["true", "yes", "0", "false"]) {
    const result = await run([binary, "--version"], { env: { BUN_BE_BUN: value } });
    truthiness.push({ value, result, ran: classify(result, versionCase.runtime) });
  }

  const preloaded = await run([binary, "serve"], { env: { BUN_OPTIONS: "--preload ./pre.ts" } });
  const plain = await run([binary, "serve"]);
  const preloadLines = preloaded.stderr.split(/\r?\n/);
  const preload = {
    result: preloaded,
    preloadRan: preloadLines.includes("preload:ran"),
    beforeGuard: preloadLines.includes("guard:started") ? preloadLines.indexOf("preload:ran") < preloadLines.indexOf("guard:started") : null,
    wrongVariant: { result: plain, preloadRan: plain.stderr.split(/\r?\n/).includes("preload:ran") },
  };

  const forcedGuard =
    candidate.entry === "guard.ts" ? await run([binary, "serve"], { env: { ENTRY_PROBE_FORCE_GUARD: "1" } }) : null;

  const runtimeReachable = cli.filter(({ selected }) => selected.ran === "runtime").map(({ name }) => name);
  const modesPass = modes.every(({ passed }) => passed) && ownVersion.stdout === "entry:version";
  const taken = runtimeReachable.length === 0 && modesPass && bundle.passed;

  const consistent =
    bundle.wrongVariant.flagged &&
    modes.every(({ wrongVariant }) => !wrongVariant.passed) &&
    cli.every(({ selected, wrongVariant }) => selected.ran !== "unknown" && wrongVariant.ran === "program") &&
    truthiness.every(({ ran }) => ran !== "unknown") &&
    !preload.wrongVariant.preloadRan &&
    (forcedGuard === null || (forcedGuard.code === 65 && forcedGuard.stderr.includes("guard:refused")));

  await rm(directory, { recursive: true, force: true });
  return {
    name: candidate.name,
    entry: candidate.entry,
    flags: candidate.flags,
    taken,
    runtimeReachable,
    modesPass,
    bundle,
    modes,
    ownVersion,
    cli,
    truthiness,
    preload,
    forcedGuard,
    consistent,
  };
};

const rows = [];
try {
  for (const candidate of candidates) rows.push(await measure(candidate));
} finally {
  await rm(work, { recursive: true, force: true });
}

const report = {
  platform: process.platform,
  arch: process.arch,
  image: `${process.env.ImageOS ?? "local"} ${process.env.ImageVersion ?? ""}`.trim(),
  bun: Bun.version,
  revision: Bun.revision,
  rows,
};
const resultsPath = resolve(process.argv[2] ?? join(import.meta.dir, "results", "result.json"));
await mkdir(dirname(resultsPath), { recursive: true });
await Bun.write(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
for (const row of rows) {
  console.log(
    `${row.name}: taken=${row.taken} runtime=[${row.runtimeReachable.join(", ")}] modes=${row.modesPass} bundle=${row.bundle.passed} preload=${row.preload.preloadRan} consistent=${row.consistent}`,
  );
}
const control = rows.find(({ name }) => name === "control");
if (!control?.modesPass || !control.bundle.passed || rows.some(({ consistent }) => !consistent)) process.exitCode = 1;
