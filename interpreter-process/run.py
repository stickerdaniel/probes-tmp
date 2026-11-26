import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import os_memory

ROOT = Path(__file__).resolve().parent
ENTRIES = ("baseline", "quick-default", "quick", "release", "restricted", "process-probe")
RUNS = [
    ("baseline", "r1"), ("quick-default", "r1"), ("quick", "r1"),
    *(("quick", "r2", mode) for mode in ("loop", "async", "regex")),
    ("quick", "r3"), ("quick", "r3-usage"), ("quick", "r4"),
    *(("quick", "r5", mode) for mode in ("sequential", "concurrent")),
    ("quick", "r6", "main"), ("quick", "r6", "worker"), ("quick", "r7"),
    *(("quick", "r7", count) for count in ("1", "10", "50")),
    ("quick", "r8"), ("restricted",),
    *(("release", "wasm", size, mode) for size in ("16", "64") for mode in ("loop", "single", "growth")),
]
PROCESS_ROWS = ("start", "rss", "watch", "control", "os-limit", "cgroup", "pending", "event")


def record(raw, name, **result):
    result = {"name": name, **result}
    contents = json.dumps(result, ensure_ascii=True)
    (raw / f"{name}.json").write_text(contents + "\n", encoding="utf-8")
    print("PROBE " + contents, flush=True)


def kill(child):
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(child.pid)], capture_output=True, timeout=5)
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def observe(command, cwd, seconds, rss_limit=0, handshake=False):
    env = os.environ.copy()
    for key in ("NODE_PATH", "BUN_OPTIONS", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"):
        env.pop(key, None)
    if handshake:
        env["PROBE_RSS_HANDSHAKE"] = "1"
    started = time.monotonic()
    deadline = started + seconds
    watchdog = None
    peak_bytes = 0
    snapshots = {}
    with tempfile.TemporaryDirectory() as temp:
        stdout, stderr = Path(temp) / "out", Path(temp) / "err"
        with stdout.open("wb") as out, stderr.open("wb") as err, stdout.open("rb") as reader:
            with subprocess.Popen(command, cwd=cwd, env=env, stdout=out, stderr=err,
                                  stdin=subprocess.PIPE if handshake else subprocess.DEVNULL,
                                  start_new_session=os.name != "nt") as child:
                try:
                    while True:
                        current = os_memory.sample(child.pid)
                        peak_bytes = max(peak_bytes, current.get("peakBytes", current["rssBytes"]))
                        if os.name == "posix":
                            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                            if pid:
                                child.returncode = os.waitstatus_to_exitcode(status)
                                factor = 1 if sys.platform == "darwin" else 1024
                                peak_bytes = max(peak_bytes, usage.ru_maxrss * factor)
                                break
                        elif child.poll() is not None:
                            current = os_memory.sample(child.pid, child._handle)
                            peak_bytes = max(peak_bytes, current.get("peakBytes", current["rssBytes"]))
                            break
                        if handshake:
                            line = reader.readline()
                            if line:
                                phase = json.loads(line).get("phase")
                                if phase in ("before", "returned", "idle-before", "idle-after"):
                                    snapshots[phase] = current["rssBytes"]
                                    child.stdin.write(b"x\n")
                                    child.stdin.flush()
                        if time.monotonic() >= deadline and not watchdog:
                            watchdog = "wall"
                            kill(child)
                            deadline = time.monotonic() + 5
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Process survived the watchdog")
                        if rss_limit and current["rssBytes"] >= rss_limit and not watchdog:
                            watchdog = "RSS"
                            snapshots["kill"] = current["rssBytes"]
                            kill(child)
                        time.sleep(0.005 if rss_limit else 0.003)
                finally:
                    if child.returncode is None:
                        kill(child)
                        child.wait(timeout=5)
        return dict(returncode=child.returncode, elapsedMs=round((time.monotonic() - started) * 1000, 3),
                    peakRssBytes=peak_bytes, rssSnapshots=snapshots, watchdog=watchdog,
                    stdout=stdout.read_text(encoding="utf-8", errors="backslashreplace").strip(),
                    stderr=stderr.read_text(encoding="utf-8", errors="backslashreplace").strip())


def binary(directory, entry):
    return directory / (entry + (".exe" if os.name == "nt" else ""))


def main():
    if sys.argv[1:] == ["monitor"]:
        os_memory.monitor()
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=Path, default=ROOT / "raw")
    parser.add_argument("--suite", choices=("all", "interpreter", "process"), default="all")
    args = parser.parse_args()
    raw = args.raw.resolve()
    raw.mkdir(parents=True, exist_ok=True)
    bun_found = shutil.which("bun")
    if bun_found is None:
        raise RuntimeError("Bun 1.4.3 is required")
    bun = Path(bun_found).resolve()
    revision = subprocess.check_output([bun, "--revision"], text=True).strip()
    if revision.split("+")[0] != "1.4.3":
        raise RuntimeError(f"Expected Bun 1.4.3, got {revision}")
    os_release = {}
    if sys.platform == "linux":
        os_release["distribution"] = platform.freedesktop_os_release()["PRETTY_NAME"]
    elif sys.platform == "darwin":
        os_release["macOS"] = subprocess.check_output(["sw_vers"], text=True).splitlines()
        os_release["cpu"] = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    else:
        os_release["win32"] = list(platform.win32_ver())
    record(raw, "versions", system=platform.system(), release=platform.release(), kernel=platform.version(),
           machine=platform.machine(), osRelease=os_release, python=platform.python_version(),
           bun=revision, quickjs="2025-09-13", quickjsEmscripten="0.32.0", variant="RELEASE_SYNC",
           runner={key: os.environ.get(key) for key in ("RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion")})
    selected = ENTRIES
    if args.suite == "process":
        selected = ("process-probe",)
    if args.suite == "interpreter":
        selected = ENTRIES[:-1]
    with tempfile.TemporaryDirectory(prefix="interpreter-probe-") as staging:
        stage = Path(staging)
        empty = stage / "empty"
        empty.mkdir()
        built = set()
        for entry in selected:
            output = binary(stage, entry)
            flags = [
                "build", "--compile", f"--compile-executable-path={bun}",
                "--compile-exec-argv=--no-install", "--no-compile-autoload-bunfig",
                "--no-compile-autoload-dotenv", "--no-compile-autoload-package-json",
                f"{entry}.ts", "--outfile", str(output),
            ]
            result = observe([bun, *flags], ROOT, 40)
            if result["returncode"] == 0 and output.is_file():
                result["binaryBytes"] = output.stat().st_size
                built.add(entry)
            record(raw, f"{entry}-build", **result)
        if args.suite != "process":
            for entry, *parameters in RUNS:
                if entry not in built:
                    continue
                stem = "-".join([entry, *parameters])
                handshake = parameters == ["r3"] or (len(parameters) == 2 and parameters[0] == "r7")
                sample_limit = 512 * os_memory.MIB if parameters == ["r3"] else 0
                record(raw, stem, **observe([binary(stage, entry), *parameters], empty, 8,
                                            rss_limit=sample_limit, handshake=handshake))
        if "process-probe" in built:
            for row in PROCESS_ROWS:
                if row == "os-limit" and sys.platform == "darwin":
                    continue
                if row == "cgroup" and sys.platform != "linux":
                    continue
                command = [binary(stage, "process-probe"), "parent", row, sys.executable, __file__]
                record(raw, f"process-{row}", **observe(command, empty, 15))
        if built != set(selected):
            raise SystemExit("One or more probes did not build")


if __name__ == "__main__":
    main()
