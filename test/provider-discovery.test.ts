import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findProviderLaunch } from "../src/runner/discovery.js";

const roots: string[] = [];
function fixture() { const root = realpathSync.native(mkdtempSync(join(tmpdir(), "collidr-discovery-"))); roots.push(root); return root; }
function file(path: string, content = "") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); chmodSync(path, 0o755); return path; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("provider launch discovery", () => {
  it.each(["linux", "darwin", "win32"] as const)("prefers native PATH executables on %s", platform => {
    const root = fixture(); const native = file(join(root, platform === "win32" ? "claude.exe" : "claude"));
    expect(findProviderLaunch("claude", { platform, env: { PATH: root }, home: root })).toEqual({ command: native, args: [] });
  });
  it("ignores shell shims and returns no missing launch", () => {
    const root = fixture(); file(join(root, "claude.cmd"));
    expect(findProviderLaunch("claude", { platform: "win32", env: { PATH: root }, home: root })).toBeUndefined();
  });
  it.each(["cli.js", { claude: "cli.js" }])("reads the advertised npm bin %j", bin => {
    const root = fixture(); const pkg = join(root, "node_modules", "@anthropic-ai", "claude-code");
    file(join(pkg, "package.json"), JSON.stringify({ bin })); const script = file(join(pkg, "cli.js"));
    expect(findProviderLaunch("claude", { platform: "win32", env: { PATH: root }, home: root })).toEqual({ command: process.execPath, args: [script] });
  });
  it.each([undefined, "missing.js", "../outside.js", "cli.cmd", { other: "cli.js" }])("rejects invalid advertised bin %j", bin => {
    const root = fixture(); const pkg = join(root, "node_modules", "@openai", "codex");
    file(join(pkg, "package.json"), JSON.stringify({ bin })); file(join(pkg, "cli.js")); file(join(pkg, "cli.cmd")); file(join(pkg, "..", "outside.js"));
    expect(findProviderLaunch("codex", { platform: "win32", env: { PATH: root, LOCALAPPDATA: root }, home: root })).toBeUndefined();
  });
  it("rejects a bin symlink escaping its package", () => {
    const root = fixture(); const pkg = join(root, "node_modules", "@openai", "codex");
    file(join(pkg, "package.json"), JSON.stringify({ bin: "escape/cli.js" })); file(join(root, "outside", "cli.js"));
    symlinkSync(join(root, "outside"), join(pkg, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(findProviderLaunch("codex", { platform: "win32", env: { PATH: root, LOCALAPPDATA: root }, home: root })).toBeUndefined();
  });
  it("prefers Claude native installation to npm", () => {
    const root = fixture(); const native = file(join(root, ".local", "bin", "claude.exe"));
    file(join(root, "node_modules", "@anthropic-ai", "claude-code", "package.json"), JSON.stringify({ bin: "cli.js" }));
    file(join(root, "node_modules", "@anthropic-ai", "claude-code", "cli.js"));
    expect(findProviderLaunch("claude", { platform: "win32", env: { PATH: root }, home: root })?.command).toBe(native);
  });
  it("uses Codex desktop fallback after npm", () => {
    const root = fixture(); const native = file(join(root, "OpenAI", "Codex", "bin", "v1", "codex.exe"));
    expect(findProviderLaunch("codex", { platform: "win32", env: { PATH: "", LOCALAPPDATA: root }, home: root })).toEqual({ command: native, args: [] });
  });
});
