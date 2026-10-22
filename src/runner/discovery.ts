import { accessSync, closeSync, constants, openSync, readSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Provider } from "./types.js";

export interface ProviderLaunch { command: string; args: string[] }
export interface DiscoveryOptions { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string }
const packages: Record<Provider, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
function isFile(file: string): boolean { try { return statSync(file).isFile(); } catch { return false; } }
function native(file: string, platform: NodeJS.Platform): ProviderLaunch | undefined {
  if (!isFile(file)) return undefined;
  try {
    if (platform !== "win32") {
      accessSync(file, constants.X_OK);
      // shell:false still follows POSIX shebangs. Only allow known Node entrypoints;
      // skip every other interpreter rather than maintaining a list of shell names.
      const fd = openSync(file, "r");
      const header = Buffer.alloc(4096);
      let length: number;
      try { length = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
      if (header[0] === 0x23 && header[1] === 0x21) {
        const interpreter = header.subarray(2, length).toString("utf8").split(/\r?\n/, 1)[0]!.trim();
        if (!/^(?:(?:\S*\/)?node(?:js)?|(?:\S*\/)?env\s+(?:-S\s+)?node(?:js)?)$/.test(interpreter)) return undefined;
        return { command: process.execPath, args: [resolve(file)] };
      }
    }
  } catch { return undefined; }
  return { command: resolve(file), args: [] };
}
function contained(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}
function npmLaunch(root: string, provider: Provider): ProviderLaunch | undefined {
  try {
    const pkg = realpathSync.native(root);
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const bin: unknown = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[provider];
    if (typeof bin !== "string" || !bin || isAbsolute(bin) || !/\.(?:c|m)?js$/i.test(bin)) return undefined;
    const script = resolve(pkg, bin);
    if (!contained(pkg, script) || !isFile(script) || !contained(pkg, realpathSync.native(script))) return undefined;
    return { command: process.execPath, args: [script] };
  } catch { return undefined; }
}

/** Discover data-only launch arguments; never execute npm, shell shims, or model turns. */
export function findProviderLaunch(provider: Provider, options: DiscoveryOptions = {}): ProviderLaunch | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const path = env.PATH ?? env.Path ?? "";
  // Tests may emulate a target OS while using the host filesystem's absolute paths.
  const separator = platform === "win32" || process.platform === "win32" ? ";" : ":";
  const dirs = path.split(separator).map(p => p.replace(/^"|"$/g, "")).filter(Boolean);
  for (const dir of dirs) {
    const launch = native(join(dir, platform === "win32" ? `${provider}.exe` : provider), platform);
    if (launch) return launch;
  }
  if (provider === "claude") {
    const launch = native(join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude"), platform);
    if (launch) return launch;
  }
  if (platform === "win32") {
    for (const dir of dirs) {
      const launch = npmLaunch(join(dir, "node_modules", packages[provider]), provider);
      if (launch) return launch;
    }
    if (provider === "codex") {
      const bin = join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "OpenAI", "Codex", "bin");
      try {
        const candidates = readdirSync(bin).map(entry => join(bin, entry, "codex.exe")).filter(isFile);
        candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        for (const file of candidates) { const launch = native(file, platform); if (launch) return launch; }
      } catch { /* No desktop install. */ }
    }
  }
  return undefined;
}
