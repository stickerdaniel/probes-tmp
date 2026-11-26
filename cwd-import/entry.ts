const out: Record<string, unknown> = { cwd_has_env: process.env.PROBE_DOTENV ?? null };
for (const spec of ["planted-pkg", "./local-file.js", "#alias"]) {
  try {
    const m = await import(spec);
    out[spec] = { loaded: true, value: m.default ?? Object.keys(m) };
  } catch (e) {
    out[spec] = { loaded: false, error: String((e as Error).message).slice(0, 120) };
  }
}
try {
  const r = Bun.resolveSync("planted-pkg", process.cwd());
  out.resolveSync = r;
} catch (e) { out.resolveSync = "error: " + String((e as Error).message).slice(0, 100); }
out.marker = await Bun.file("preload-marker.txt").exists();
console.log(JSON.stringify(out));
