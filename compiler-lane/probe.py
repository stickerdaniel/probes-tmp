import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from time import perf_counter

TS_DIAGNOSTIC = re.compile(r"^(.+)\((\d+),(\d+)\): (error|warning) TS(\d+): (.+)$")
SOURCE_RULES = {
    "dropped-effect": "floatingEffect",
    "missing-service": "missingEffectContext",
    "sibling-layer": "layerMergeAllWithDependencies",
}


def measure(args):
    start = perf_counter()
    completed = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    elapsed = perf_counter() - start
    peak = None
    if platform.system() != "Windows":
        import resource

        peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        if platform.system() == "Darwin":
            peak //= 1024
    print(json.dumps({
        "seconds": round(elapsed, 3),
        "peakKiB": peak,
        "exit": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }))


def checked(cwd, args):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def relative(cwd, filename):
    return os.path.relpath(filename, cwd).replace("\\", "/") if os.path.isabs(filename) else Path(filename).as_posix()


def observe(cwd, args, checker):
    result = json.loads(checked(cwd, [sys.executable, str(Path(__file__).resolve()), "--measure", *args]))
    stdout = result.pop("stdout")
    stderr = result.pop("stderr")
    if checker == "tsc":
        lines = (stdout + "\n" + stderr).splitlines()
        diagnostics = []
        for line in lines:
            match = TS_DIAGNOSTIC.fullmatch(line)
            if match:
                file, number, column, severity, code, message = match.groups()
                diagnostics.append({
                    "file": relative(cwd, file), "line": int(number), "column": int(column),
                    "severity": severity, "code": int(code), "message": message,
                })
            elif line.startswith("  ") and diagnostics:
                diagnostics[-1]["message"] += "\n" + line.strip()
            elif re.match(r"^(?:error|warning) TS\d+:", line):
                raise RuntimeError(line)
        if result["exit"] != (2 if diagnostics else 0):
            raise RuntimeError(stdout + stderr)
    elif checker == "service":
        data = json.loads(stdout)
        diagnostics = data["diagnostics"]
        for diag in diagnostics:
            diag["file"] = relative(cwd, diag["file"])
        result["filesChecked"] = data["summary"]["filesChecked"]
        if stderr or result["exit"] not in (0, 1):
            raise RuntimeError(stdout + stderr)
    else:
        diagnostics = []
        if result["exit"] or stdout:
            result["output"] = stdout + stderr
    result["diagnostics"] = diagnostics
    return result


def measure_project(root, config, service_cli, cases):
    stock = ["bun", "run", "typecheck", "--pretty", "false", "--project", config]
    service = [
        "bun", str(service_cli), "diagnostics", "--project", config, "--format", "json",
        "--lspconfig", '{"name":"@effect/language-service"}',
    ]
    rows = []
    for label, file, before, after, edit_line in [("clean", None, None, None, 0), *cases]:
        path = root / file if file else None
        original = path.read_bytes() if path else None
        if path:
            source = original.decode().replace("\r\n", "\n")
            if source.count(before) != 1:
                raise RuntimeError(f"{file} lacks a unique anchor for {label}")
            line = source[:source.index(before)].count("\n") + 1 + edit_line
        else:
            line = None
        try:
            if path:
                path.write_text(source.replace(before, after, 1), encoding="utf-8", newline="\n")
            for checker, command in (("tsc", stock), ("service", service)):
                runs = [observe(root, command, checker) for _ in range(2)]
                if runs[0]["diagnostics"] != runs[1]["diagnostics"]:
                    raise RuntimeError(f"Unstable diagnostics for {label} with {checker}")
                rows.append({
                    "case": label, "checker": checker, "file": file, "line": line,
                    "cold": runs[0], "warm": runs[1],
                })
        finally:
            if path:
                path.write_bytes(original)
    listed = checked(root, [*stock, "--listFilesOnly"]).splitlines()
    workspace = [relative(root, file) for file in listed if Path(file).resolve().is_relative_to(root) and "node_modules" not in Path(file).parts]
    return {
        "stockFiles": len(listed),
        "stockWorkspaceFiles": len(workspace),
        "stockWorkspacePaths": workspace,
        "stockBunOrNodeDeclarations": sum(bool(re.search(r"/(?:bun-types|@types/(?:bun|node))/", file.replace("\\", "/"))) for file in listed),
        "rows": rows,
    }


def at_edit(row):
    return [
        diag for diag in row["cold"]["diagnostics"]
        if (diag["file"], diag["line"]) == (row["file"], row["line"])
    ]


def summarize(root, results, boundary_cmd, destination):
    boundary = observe(root, boundary_cmd, "boundary")
    result = {
        "platform": platform.platform(),
        "bun": checked(root, ["bun", "--version"]),
        "node": checked(root, ["node", "--version"]),
        "boundary": boundary,
        "projects": results,
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if boundary["exit"]:
        raise RuntimeError("The TypeScript API boundary check failed")


def stand_in(root, destination):
    cli = root / "node_modules/@effect/language-service/cli.js"
    projects = {
        "engine": [
            ("ordinary-engine", "engine/main.ts", "const count: number = Bun.argv.length;", 'const count: number = "wrong";', 0),
            ("dropped-effect", "engine/main.ts", "  return Effect.runPromise", '  Effect.log("dropped");\n  return Effect.runPromise', 0),
            ("missing-service", "engine/main.ts", "Output.pipe(Effect.provide(services), ", "Output.pipe(", 0),
            ("sibling-layer", "engine/main.ts", "output.pipe(Layer.provide(input))", "Layer.mergeAll(input, output)", 0),
        ],
        "portable": [
            ("ordinary-portable", "portable/frame.ts", "=> frame.byteLength;", '=> "wrong";', 0),
        ],
        "tooling": [
            ("ordinary-tooling", "tooling/boundaries.ts", "  return file.statements[0]?.kind ?? ts.SyntaxKind.EndOfFileToken;", '  return "wrong";', 0),
        ],
    }
    results = {
        project: measure_project(root, f"{project}/tsconfig.json", cli, cases)
        for project, cases in projects.items()
    }
    summarize(root, results, ["bun", "tooling/boundaries.ts"], destination)
    if results["portable"]["stockBunOrNodeDeclarations"] != 0:
        raise RuntimeError("The portable compiler program loaded Bun or Node types")
    for project in results.values():
        for row in project["rows"]:
            if row["case"] == "clean" and row["cold"]["diagnostics"]:
                raise RuntimeError(f"Unexpected diagnostics in the clean {row['checker']} control")
            if row["checker"] == "tsc" and row["case"].startswith("ordinary") and not at_edit(row):
                raise RuntimeError(f"The {row['case']} control did not hit the fault line")
            rule = SOURCE_RULES.get(row["case"])
            if row["checker"] == "service" and rule and not any(diag["name"] == rule for diag in at_edit(row)):
                raise RuntimeError(f"{rule} did not hit the fault line")


if __name__ == "__main__":
    if sys.argv[1] == "--measure":
        measure(sys.argv[2:])
    else:
        stand_in(Path.cwd(), Path(sys.argv[1]))
