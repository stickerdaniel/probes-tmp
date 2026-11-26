import concurrent.futures
import json
from pathlib import Path
import re
from urllib.request import urlopen

REVISION = "4db99ac4dc8924279ae07ed3246385924e878519"
BASE = f"https://raw.githubusercontent.com/tc39/test262/{REVISION}"
GROUPS = {
    "built-ins/Array/prototype/toSorted": [
        "comparefn-default", "comparefn-controls-sort", "holes-not-preserved", "immutable", "this-value-nullish",
    ],
    "built-ins/JSON/stringify": [
        "value-string-escape-ascii", "value-string-escape-unicode", "value-tojson-arguments", "value-tojson-result",
    ],
    "built-ins/Map/prototype/get": [
        "get", "returns-undefined", "returns-value-different-key-types", "returns-value-normalized-zero-key",
    ],
    "built-ins/RegExp/prototype/test": [
        "S15.10.6.3_A1_T1", "S15.10.6.3_A1_T2", "y-fail-return", "y-set-lastindex",
    ],
    "language/expressions/optional-chaining": [
        "optional-call-preserves-this", "member-expression", "short-circuiting",
    ],
}


def fetch(path):
    with urlopen(f"{BASE}/{path}", timeout=15) as response:
        return response.read().decode("utf-8")


def main():
    paths = [f"test/{group}/{name}.js" for group, names in GROUPS.items() for name in names]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        sources = dict(zip(paths, pool.map(fetch, paths)))
        headers = {path: source.split("/*---", 1)[1].split("---*/", 1)[0] for path, source in sources.items()}
        includes = {"assert.js", "sta.js"}
        tests = []
        for path, header in headers.items():
            flags = re.search(r"^flags:\s*\[(.*?)\]", header, re.M)
            if re.search(r"^negative:", header, re.M) or (flags and flags[1] != "onlyStrict"):
                raise ValueError(f"Unsupported sample metadata: {path}")
            extra = re.search(r"^includes:\s*\[(.*?)\]", header, re.M)
            names = [name.strip() for name in extra[1].split(",")] if extra else []
            includes.update(names)
            tests.append(dict(path=path, source=sources[path], includes=names))
        harness = dict(zip(sorted(includes), pool.map(fetch, [f"harness/{name}" for name in sorted(includes)])))
    output = Path(__file__).with_name("test262.json")
    output.write_text(json.dumps(dict(revision=REVISION, harness=harness, tests=tests)), encoding="utf-8")


if __name__ == "__main__":
    main()
