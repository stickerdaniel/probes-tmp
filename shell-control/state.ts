import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const appId = "dev.probe.shellcontrol";
const runKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function registryState(hive: "CurrentUser" | "LocalMachine") {
  const read = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::${hive}.OpenSubKey('${runKey}'); if ($key) { ConvertTo-Json -InputObject ($key.GetValue('${appId}')) -Compress } else { 'null' }`]);
  assert.equal(read.exitCode, 0, read.stderr.toString());
  return JSON.parse(read.stdout.toString().trim()) as string | null;
}

export function autostartState() {
  if (process.platform === "win32") {
    const currentUser = registryState("CurrentUser");
    const localMachine = registryState("LocalMachine");
    return { enabled: currentUser !== null, target: currentUser?.trim() ?? null,
      source: `HKCU\\${runKey}`, localMachine };
  }

  const mac = process.platform === "darwin";
  const file = mac
    ? join(homedir(), "Library", "LaunchAgents", `${appId}.plist`)
    : join(homedir(), ".config", "autostart", `${appId}.desktop`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { enabled: false, target: null, source: file };
    }
    throw error;
  }
  if (mac) {
    const extract = (key: string) => {
      const read = Bun.spawnSync(["plutil", "-extract", key, "raw", "-o", "-", file]);
      assert.equal(read.exitCode, 0, read.stderr.toString());
      return read.stdout.toString().trim();
    };
    assert.equal(extract("Label"), appId);
    assert.equal(extract("RunAtLoad"), "true");
    return { enabled: true, target: extract("ProgramArguments.0"), source: file, raw };
  }
  return { enabled: true, target: /^Exec=(.+)$/m.exec(raw)?.[1]?.trim() ?? null, source: file, raw };
}

export function matchesAutostart(state: ReturnType<typeof autostartState>, enabled: boolean, executable: string) {
  if (state.enabled !== enabled || ("localMachine" in state && state.localMachine !== null)) return false;
  if (!enabled) return true;
  try {
    const actual = realpathSync(state.target ?? "");
    return actual === realpathSync(executable);
  } catch {
    return false;
  }
}
