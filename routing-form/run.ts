import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cases, cold, reopened, sectionWalk, variants, warm, type Case, type Variant } from "./shared/fixtures";

const bundle = resolve(process.argv[2]);
const root = resolve(process.argv[3]);
const mac = process.platform === "darwin";
const registration = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const marker = join(tmpdir(), "routeprobe-session.json");
const position = process.env.ROUTEPROBE_POSITION;
const readyDeadline = 50_000;

type Record = {
  kind: string;
  pid: number;
  case?: Case;
  status?: string;
  link?: number;
  windows?: number;
  visible?: boolean;
  failed?: boolean;
  errors?: string[];
  reason?: string;
  observation?: { location: string; browser: string; heading: string; inputs: string[] };
};

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit", timeout: readyDeadline });
  assert.equal(await child.exited, 0, args[0]);
}

function open(url: string, forceNew = false) {
  if (mac) {
    const environment = ["--env", `ROUTEPROBE_SESSION=${marker}`];
    if (position) environment.push("--env", `ROUTEPROBE_POSITION=${position}`);
    return command(["open", "-g", "-a", bundle, ...environment, ...(forceNew ? ["-n", "--args"] : []), url]);
  }
  if (process.platform === "win32") return command(["rundll32.exe", "url.dll,FileProtocolHandler", url]);
  return command(["xdg-open", url]);
}

function read(path: string): Record[] {
  return readFileSync(path, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
}

function waitFor<T>(path: string, select: (records: Record[]) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const records = read(path);
        const shellError = records.find((row) => row.kind === "shell-error");
        if (shellError) throw new Error(JSON.stringify(shellError));
        const selected = select(records);
        if (selected !== undefined) {
          close();
          resolve(selected);
        }
      } catch (error) {
        close();
        reject(error);
      }
    };
    const listener = watch(path, check);
    const fallback = setInterval(check, 100);
    const deadline = setTimeout(() => {
      close();
      reject(new Error("Deadline reached waiting for a probe event"));
    }, readyDeadline);
    const close = () => {
      listener.close();
      clearInterval(fallback);
      clearTimeout(deadline);
    };
    check();
  });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

async function exited(pid: number, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (alive(pid) && performance.now() < deadline) await Bun.sleep(40);
  assert.equal(alive(pid), false, `PID ${pid} survived the exit deadline`);
}

const log = (row: object) => appendFileSync(join(root, "driver.jsonl"), JSON.stringify(row) + "\n");

async function session(variant: Variant) {
  const output = join(root, variant + ".jsonl");
  const stop = join(root, variant + ".stop");
  writeFileSync(output, "", { flag: "wx" });
  writeFileSync(marker, JSON.stringify({ variant, output, stop }));
  const row = (name: Case, link?: number) => waitFor(output, (records) =>
    records.find((row) => row.kind === "row" && row.case === name && (link === undefined || row.link === link)));

  function check(record: Record, status: "pass" | "fail") {
    assert.equal(record.status, status, JSON.stringify(record));
    assert.deepEqual(record.errors ?? [], []);
    if (status === "pass") {
      assert.equal(record.windows, 1);
      assert.equal(record.visible, true);
    }
  }

  try {
    await open(cold.url);
    if (variant === "entry-404") {
      const blank = await row("cold");
      check(blank, "fail");
      assert.equal(blank.reason, "Entry document returned 404");
      assert.ok(await waitFor(output, (records) => records.find((record) => record.kind === "asset" && record.failed)));
      return;
    }
    const first = await row("cold", 0);
    check(first, "pass");
    assert.deepEqual(read(output).filter((record) => record.kind === "asset" && record.failed), []);

    await open(warm.url);
    if (mac) {
      const system = await waitFor(output, (records) => records.find((record) => record.kind === "system-link"));
      check(system, "pass");
      assert.equal(system.pid, first.pid);
      assert.equal(read(output).filter((record) => record.kind === "process").length, 1);
      await open(reopened.url, true);
    }

    const second = await waitFor(output, (records) => records.find((record) => record.kind === "process" && record.pid !== first.pid));
    await exited(second.pid);
    const forwarded = await row("warm", mac ? 2 : 1);
    assert.equal(forwarded.pid, first.pid);
    check(forwarded, variant === "warm-query" ? "fail" : "pass");
    log({ variant, first: first.pid, secondary: second.pid, secondaryExited: true });
    if (variant === "warm-query") {
      const destination = mac ? reopened : warm;
      assert.equal(forwarded.observation?.location, destination.path.split("?")[0]);
      assert.equal(forwarded.observation?.heading, destination.name);
      assert.deepEqual(forwarded.observation?.inputs, ["", "", ""]);
      return;
    }

    if (variant !== "draft") {
      const history = await row("history");
      check(history, variant === "history" ? "fail" : "pass");
      if (variant === "history") {
        assert.ok(history.reason?.startsWith("Error: Expected /tools and Tools."));
        assert.equal(history.observation?.location, sectionWalk[0][0]);
      }
    }
    if (variant !== "history") {
      const draft = await row("draft");
      check(draft, variant === "draft" ? "fail" : "pass");
      if (variant === "draft") {
        assert.equal(draft.observation?.location, cold.path.split("?")[0]);
        assert.deepEqual(draft.observation?.inputs, ["", "", ""]);
      }
    }
    assert.deepEqual(read(output).filter((record) => record.kind === "asset" && record.failed), []);
    if (variant === "normal") {
      assert.deepEqual(new Set(read(output).filter((record) => record.kind === "row").map((record) => record.case)), new Set(cases));
    }
  } finally {
    writeFileSync(stop, "");
    const pids = read(output).filter((record) => record.kind === "process").map((record) => record.pid);
    for (const pid of pids) {
      try {
        await exited(pid, 3500);
      } catch {
        if (alive(pid)) process.kill(pid, "SIGKILL");
        await exited(pid);
      }
    }
    rmSync(stop);
    log({ variant, stopped: pids });
  }
}

assert.ok(existsSync(bundle), "Package or executable is missing");
mkdirSync(root, { recursive: true });
writeFileSync(marker, "", { flag: "wx" });
const requested = process.argv[4];
assert.ok(requested === undefined || (variants as readonly string[]).includes(requested));
const selected = requested ? [requested as Variant] : variants;
let failures = 0;

try {
  if (mac) await command([registration, "-f", bundle]);
  for (const variant of selected) {
    try {
      await session(variant);
      log({ variant, driver: "pass" });
    } catch (error) {
      failures++;
      log({ variant, driver: "fail", reason: String(error) });
      console.error(variant, error);
    }
  }
} finally {
  rmSync(marker);
  if (mac) await command([registration, "-u", bundle]);
}
process.exitCode = failures ? 1 : 0;
