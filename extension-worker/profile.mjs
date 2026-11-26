import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const shellArg = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function chromeExecutable() {
  if (process.env.PROBE_CHROME) return process.env.PROBE_CHROME;
  const candidates = windows
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('Google Chrome Stable executable missing from runner');
  return executable;
}

export async function createProfile(directory, origin, cert, native) {
  const extension = join(directory, 'extension');
  const profile = join(directory, 'profile');
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...hash].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  const nativeName = 'org.example.relay_extension.' + id;
  await mkdir(extension);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({
    name: 'Loopback SSE relay',
    version: '1.0.0',
    manifest_version: 3,
    key: der.toString('base64'),
    background: { service_worker: 'worker.js' },
    permissions: ['nativeMessaging', 'scripting', 'debugger'],
    optional_host_permissions: ['https://*/*'],
  }));
  await writeFile(join(extension, 'config.js'),
    'const useNative = ' + native + '; const fixtureOrigin = ' + JSON.stringify(origin) +
    '; const nativeName = ' + JSON.stringify(nativeName) + ';\n');
  await writeFile(join(extension, 'control.html'), '<!doctype html><title>Loopback probe control</title>');
  for (const file of ['worker.js', 'content.js']) {
    await copyFile(new URL(file, import.meta.url), join(extension, file));
  }
  return { extension, profile, id, nativeName, cert };
}

export async function registerHost(directory, origin, profile) {
  const { nativeName, id, cert } = profile;
  const script = fileURLToPath(new URL('native.mjs', import.meta.url));
  const config = join(directory, 'host.json');
  const launcher = join(directory, windows ? 'host.exe' : 'host');
  const manifests = windows ? directory : join(profile.profile, 'NativeMessagingHosts');
  const manifest = join(manifests, nativeName + '.json');
  const registry = windows ? 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + nativeName : null;
  await writeFile(config, JSON.stringify({ origin, cert }));
  if (windows) {
    const compiler = join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', '/out:' + launcher,
      fileURLToPath(new URL('host.cs', import.meta.url))], { windowsHide: true });
  } else {
    await writeFile(launcher, '#!/bin/sh\nexec ' + [process.execPath, script].map(shellArg).join(' ') + '\n',
      { mode: 0o700 });
  }
  await mkdir(manifests, { recursive: true });
  await writeFile(manifest, JSON.stringify({
    name: nativeName,
    description: 'Loopback SSE relay',
    path: launcher,
    type: 'stdio',
    allowed_origins: ['chrome-extension://' + id + '/'],
  }));
  if (registry) {
    execFileSync('reg.exe', ['add', registry, '/ve', '/t', 'REG_SZ', '/d', manifest, '/reg:64'],
      { windowsHide: true });
    execFileSync('reg.exe', ['query', registry, '/ve', '/reg:64'], { windowsHide: true });
  }
  return {
    registration: { manifest, launcher, registry, registryView: windows ? 64 : null, allowedOrigin: 'chrome-extension://' + id + '/' },
    hostEnv: { PROBE_HOST_CONFIG: config, PROBE_HOST_NODE: process.execPath, PROBE_HOST_SCRIPT: script },
    remove() {
      if (registry) execFileSync('reg.exe', ['delete', registry, '/f', '/reg:64'], { windowsHide: true });
    },
  };
}
