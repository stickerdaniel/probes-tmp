console.error("guard:started");

const { BUN_BE_BUN, BUN_OPTIONS, ENTRY_PROBE_FORCE_GUARD } = process.env;
if (BUN_BE_BUN !== undefined || BUN_OPTIONS !== undefined || ENTRY_PROBE_FORCE_GUARD === "1") {
  console.error("guard:refused");
  process.exit(65);
}

await import("./entry.ts");
export {};
