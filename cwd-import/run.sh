set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../.probe-output"
rm -rf "$out" && mkdir -p "$out/planted/node_modules/planted-pkg" "$out/empty" "$out/moved"
ext=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ext=".exe";; esac
bun build --compile --compile-autoload-package-json --no-compile-autoload-dotenv --no-compile-autoload-bunfig --compile-exec-argv=--no-install "$here/entry.ts" --outfile "$out/four$ext"
bun build --compile "$here/entry.ts" --outfile "$out/control$ext"
printf '%s\n' '{"name":"planted-pkg","version":"1.0.0","main":"index.js"}' > "$out/planted/node_modules/planted-pkg/package.json"
printf '%s\n' 'export default "code from the start directory node_modules ran";' > "$out/planted/node_modules/planted-pkg/index.js"
printf '%s\n' 'export default "code from the start directory local file ran";' > "$out/planted/local-file.js"
printf '%s\n' 'export default "code from the start directory alias ran";' > "$out/planted/alias-target.js"
printf '%s\n' '{"name":"start","type":"module","imports":{"#alias":"./alias-target.js"},"main":"./local-file.js"}' > "$out/planted/package.json"
printf '%s\n' 'preload = ["./preload.js"]' > "$out/planted/bunfig.toml"
printf '%s\n' 'await Bun.write("preload-marker.txt","preload ran");' > "$out/planted/preload.js"
printf '%s\n' 'PROBE_DOTENV=fixture' > "$out/planted/.env"
for b in four control; do
  for d in planted empty; do
    rm -f "$out/$d/preload-marker.txt"
    printf '== %s in %s\n' "$b" "$d"
    (cd "$out/$d" && "$out/$b$ext")
  done
done | tee "$out/result.txt"
