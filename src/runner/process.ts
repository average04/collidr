import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import type { Provider } from "./types.js";

export function validateCommand(command: string): void {
  if (!command.trim() || /[\r\n\0]/.test(command) || /\.(cmd|bat|ps1)$/i.test(command)) {
    throw new Error("Use a native executable, or node with a script argument; shell wrappers are not supported.");
  }
}

function executableOnPath(command: string): string | undefined {
  const names = process.platform === "win32" && !extname(command) ? [`${command}.exe`] : [command];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const file = join(dir.replace(/^"|"$/g, ""), name);
      if (existsSync(file) && statSync(file).isFile()) return resolve(file);
    }
  }
  return undefined;
}

export function findProviderCommand(provider: Provider): string {
  const onPath = executableOnPath(provider);
  if (onPath) return onPath;
  if (process.platform === "win32") {
    if (provider === "claude") {
      const native = join(homedir(), ".local", "bin", "claude.exe");
      if (existsSync(native)) return native;
    } else {
      const bin = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
      if (existsSync(bin)) {
        const candidates = readdirSync(bin).map(entry => join(bin, entry, "codex.exe")).filter(existsSync);
        candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (candidates[0]) return candidates[0];
      }
    }
  }
  // Keep init useful before a provider is installed; start reports the missing executable.
  return provider;
}

// A fixed Windows PowerShell program creates the native provider suspended,
// assigns it to a private Job Object, then resumes it. Descendants inherit the
// job, including detached processes. Closing the owning wrapper kills the job;
// ordinary completion explicitly terminates it and verifies it is empty.
// Command/argv are data in an environment variable, never PowerShell source.
const WINDOWS_JOB_WRAPPER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $launch = ConvertFrom-Json -InputObject $env:COLLIDR_RUNNER_LAUNCH
  Remove-Item Env:COLLIDR_RUNNER_LAUNCH
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class CollidrOwnedProcess {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long A, B, C, D; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out Accounting info, uint size, IntPtr returnedSize);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  static void Check(bool okay) { if (!okay) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static void EmptyJob(IntPtr job) {
    Check(TerminateJobObject(job, 1));
    var timer = Stopwatch.StartNew();
    while (true) {
      Accounting info; Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.ActiveProcesses == 0) return;
      if (timer.ElapsedMilliseconds >= 4000) throw new Exception("Owned Windows process job did not become empty");
      Thread.Sleep(20);
    }
  }
  public static int Run(string executable, string[] args, string directory, string stopName, int supervisorPid) {
    IntPtr job = IntPtr.Zero, supervisor = IntPtr.Zero; ProcessInfo info = new ProcessInfo(); bool assigned = false;
    using (var stop = new EventWaitHandle(false, EventResetMode.ManualReset, stopName)) {
      try {
        supervisor = OpenProcess(0x101000, false, supervisorPid); Check(supervisor != IntPtr.Zero);
        long parentCreated, wrapperCreated, ignoredA, ignoredB, ignoredC;
        Check(GetProcessTimes(supervisor, out parentCreated, out ignoredA, out ignoredB, out ignoredC));
        Check(GetProcessTimes(GetCurrentProcess(), out wrapperCreated, out ignoredA, out ignoredB, out ignoredC));
        if (parentCreated > wrapperCreated || WaitForSingleObject(supervisor, 0) != 258) throw new Exception("Runner supervisor exited before provider launch");
        job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
        var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
        var startup = new Startup(); startup.Size = Marshal.SizeOf(typeof(Startup)); startup.Flags = 0x100;
        startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
        Check(SetHandleInformation(startup.Input, 1, 1)); Check(SetHandleInformation(startup.Output, 1, 1)); Check(SetHandleInformation(startup.Error, 1, 1));
        var commandLine = new StringBuilder(Quote(executable)); foreach (string arg in args) commandLine.Append(" ").Append(Quote(arg));
        Check(CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref startup, out info));
        Check(AssignProcessToJobObject(job, info.Process)); assigned = true;
        if (WaitForSingleObject(stop.SafeWaitHandle.DangerousGetHandle(), 0) != 0 && WaitForSingleObject(supervisor, 0) == 258) Check(ResumeThread(info.Thread) != UInt32.MaxValue);
        uint waited = WaitForMultipleObjects(3, new IntPtr[] { info.Process, stop.SafeWaitHandle.DangerousGetHandle(), supervisor }, false, UInt32.MaxValue);
        Check(waited != UInt32.MaxValue);
        uint code = 1;
        if (waited == 0) Check(GetExitCodeProcess(info.Process, out code));
        EmptyJob(job);
        return unchecked((int)code);
      } finally {
        if (info.Process != IntPtr.Zero && !assigned) TerminateProcess(info.Process, 1);
        if (job != IntPtr.Zero) CloseHandle(job);
        if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
        if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
        if (supervisor != IntPtr.Zero) CloseHandle(supervisor);
      }
    }
  }
}
'@
  $code = [CollidrOwnedProcess]::Run([string]$launch.command, [string[]]$launch.args, [string]$launch.cwd, [string]$launch.stopEvent, [int]$launch.supervisorPid)
  exit $code
} catch {
  [Console]::Error.WriteLine('Runner process ownership failure: ' + $_.Exception.Message)
  exit 250
}
`;

const WINDOWS_STOP_JOB = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$deadline = [DateTime]::UtcNow.AddSeconds(8)
do {
  try {
    $stop = [Threading.EventWaitHandle]::OpenExisting($env:COLLIDR_RUNNER_STOP_EVENT)
    [void]$stop.Set()
    $stop.Dispose()
    exit 0
  } catch [Threading.WaitHandleCannotBeOpenedException] { Start-Sleep -Milliseconds 50 }
} while ([DateTime]::UtcNow -lt $deadline)
[Console]::Error.WriteLine('Timed out opening the owned process stop event')
exit 1
`;

interface OwnedProcess { stopEvent?: string; closed: Promise<void>; isClosed: boolean; termination?: Promise<void> }
const ownedProcesses = new WeakMap<ChildProcess, OwnedProcess>();
const powershellPath = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const powershellArgs = (script: string) => ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];

export function spawnAgent(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  validateCommand(command);
  const executable = isAbsolute(command) ? command : executableOnPath(command) ?? command;
  if (process.platform === "win32" && (!isAbsolute(executable) || !existsSync(executable))) throw new Error(`Native executable not found: ${command}`);
  const stopEvent = process.platform === "win32" ? `Local\\CollidrRunner-${randomUUID()}` : undefined;
  const child = spawn(stopEvent ? powershellPath() : executable, stopEvent ? powershellArgs(WINDOWS_JOB_WRAPPER) : args, {
    cwd: options.cwd, env: { ...process.env, ...options.env, ...(stopEvent ? {
      COLLIDR_RUNNER_LAUNCH: JSON.stringify({ command: executable, args, cwd: options.cwd, stopEvent, supervisorPid: process.pid }),
    } : {}) },
    shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  const owned: OwnedProcess = { stopEvent, isClosed: false, closed: new Promise<void>(resolveClose => {
    child.once("close", () => { owned.isClosed = true; resolveClose(); });
  }) };
  ownedProcesses.set(child, owned);
  return child;
}

async function bounded(promise: Promise<void>, ms: number, message: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function signalWindowsJob(stopEvent: string, wrapperClosed: Promise<void>): Promise<void> {
  const signaler = spawn(powershellPath(), powershellArgs(WINDOWS_STOP_JOB), {
    shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, COLLIDR_RUNNER_STOP_EVENT: stopEvent },
  });
  const closed = new Promise<void>((resolveClose, reject) => {
    signaler.once("error", reject);
    signaler.once("close", code => code === 0 ? resolveClose() : reject(new Error("Could not signal the owned Windows process job")));
  });
  try { await bounded(Promise.race([closed, wrapperClosed]), 10000, "Windows process stop helper timed out"); }
  finally {
    if (signaler.exitCode === null && signaler.signalCode === null) signaler.kill();
    await bounded(closed.catch(() => {}), 2000, "Windows stop helper did not exit");
  }
}

/** Await confirmed cleanup. Windows ownership is a Job Object, never a PID lookup. */
export function terminateChild(child: ChildProcess): Promise<void> {
  const owned = ownedProcesses.get(child);
  if (owned?.termination) return owned.termination;
  const cleanup = async () => {
    if (!child.pid) return;
    if (owned?.stopEvent) {
      if (!owned.isClosed) {
        try { await signalWindowsJob(owned.stopEvent, owned.closed); }
        catch (error) { if (!owned.isClosed) { child.kill(); await bounded(owned.closed, 5000, "Windows process job wrapper did not exit"); throw error; } }
        await bounded(owned.closed, 6000, "Owned Windows process job did not stop");
      }
      if (child.exitCode === 250) throw new Error("Windows process ownership or cleanup could not be verified");
      return;
    }
    if (process.platform !== "win32" && owned) {
      const exists = () => { try { process.kill(-child.pid!, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
      const signalGroup = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
      signalGroup("SIGTERM");
      for (let i = 0; i < 40 && exists(); i++) await new Promise(resolveWait => setTimeout(resolveWait, 50));
      if (exists()) signalGroup("SIGKILL");
      for (let i = 0; i < 40 && exists(); i++) await new Promise(resolveWait => setTimeout(resolveWait, 50));
      if (exists()) throw new Error("Owned process group is still alive after termination");
      await bounded(owned.closed, 2000, "Owned process streams did not close");
      return;
    }
    // Non-provider children (the CLI startup handshake) have no managed tree.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolveClose => child.once("close", resolveClose));
    child.kill();
    await bounded(closed, 5000, "Child process did not stop");
  };
  const promise = cleanup();
  if (owned) owned.termination = promise;
  return promise;
}
