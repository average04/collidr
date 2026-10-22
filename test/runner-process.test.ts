import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { spawnAgent, terminateChild, validateCommand, findProviderCommand } from "../src/runner/process.js";

describe("runner process boundary", () => {
  it("passes prompt-like arguments literally without a shell", async () => {
    const literal = '$(Write-Output secret); & echo injected `test`';
    const child = spawnAgent(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal], { cwd: process.cwd() });
    let output = ""; child.stdout.on("data", b => output += b.toString());
    const [code] = await once(child, "close");
    expect(code).toBe(0); expect(output).toBe(literal);
  });
  it("rejects command scripts instead of invoking a shell", () => {
    for (const command of ["claude.cmd", "runner.bat", "codex.ps1"]) expect(() => validateCommand(command)).toThrow(/native|shell/i);
  });
  it("terminates a running owned child and is safe to repeat", async () => {
    const child = spawnAgent(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(()=>{},1000)"], { cwd: process.cwd() });
    await once(child.stdout, "data");
    await terminateChild(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await terminateChild(child);
  });
  it("reaps an owned descendant after its direct provider parent has exited", async () => {
    const source = `const {spawn}=require('node:child_process'); const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:process.platform==='win32',windowsHide:true}); process.stdout.write(String(descendant.pid)); descendant.unref();`;
    const child = spawnAgent(process.execPath, ["-e", source], { cwd: process.cwd() });
    let output = "";
    child.stdout.on("data", chunk => output += chunk.toString());
    await once(child, "close");
    const descendantPid = Number(output);
    expect(descendantPid).toBeGreaterThan(0);
    try {
      await terminateChild(child);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
    }
  });
  it.runIf(process.platform === "win32")("skips an npm POSIX shim when discovering the native Windows executable", () => {
    const directory = mkdtempSync(join(tmpdir(), "collidr-native-command-"));
    const oldPath = process.env.PATH;
    const shim = join(directory, "npm");
    const native = join(directory, "native");
    mkdirSync(shim); mkdirSync(native);
    writeFileSync(join(shim, "claude"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(native, "claude.exe"), "native executable lookup fixture");
    try {
      process.env.PATH = [shim, native].join(delimiter);
      expect(findProviderCommand("claude")).toBe(join(native, "claude.exe"));
    } finally {
      process.env.PATH = oldPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.runIf(process.platform === "win32")("stops its entire owned job when the supervising process dies", async () => {
    const helper = pathToFileURL(join(process.cwd(), "dist", "runner", "process.js")).href;
    const provider = `const {spawn}=require('node:child_process'); const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true}); descendant.unref(); process.stdout.write(JSON.stringify({provider:process.pid,descendant:descendant.pid})+'\\n'); setInterval(()=>{},1000);`;
    const source = `const {spawnAgent}=await import(${JSON.stringify(helper)}); const child=spawnAgent(process.execPath,['-e',${JSON.stringify(provider)}],{cwd:process.cwd()}); process.stdout.write(JSON.stringify({wrapper:child.pid})+'\\n'); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);`;
    const supervisor = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const pids: number[] = [];
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error(`Provider did not become ready: ${output}`)), 10000);
        supervisor.once("error", error => { clearTimeout(timer); reject(error); });
        supervisor.stdout.on("data", chunk => {
          output += chunk.toString();
          const lines = output.trim().split("\n");
          if (lines.length < 2) return;
          try {
            const wrapper = JSON.parse(lines[0]!).wrapper as number;
            const child = JSON.parse(lines[1]!) as { provider: number; descendant: number };
            pids.push(wrapper, child.provider, child.descendant);
            clearTimeout(timer); resolveReady();
          } catch { /* wait for a complete line */ }
        });
      });
      supervisor.kill();
      await once(supervisor, "close");
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 50));
      expect(pids.filter(alive)).toEqual([]);
    } finally {
      supervisor.kill();
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } }
    }
  });
});
