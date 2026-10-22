import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcessIdentityProbe {
  alive(pid: number): boolean;
  identity(pid: number): string | null;
}

const PROBE_TIMEOUT_MS = 2000;
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;
let ownIdentity: string | null = null;

// Fixed source, with the validated PID passed as data rather than interpolated
// PowerShell. StartTime is an OS creation time, independent of process name.
const WINDOWS_IDENTITY = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $targetId = [int]::Parse($env:COLLIDR_RUNNER_IDENTITY_PID, [Globalization.CultureInfo]::InvariantCulture)
  $targetProcess = [Diagnostics.Process]::GetProcessById($targetId)
  [Console]::Out.Write($targetProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))
} catch { exit 1 }
finally { if ($null -ne $targetProcess) { $targetProcess.Dispose() } }
`;

/** EPERM and other uncertainty must never permit overlapping invocations. */
export function processAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function queryIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot)) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (!stat.startsWith(`${pid} (`)) return null;
    // comm (field 2) can contain spaces, newlines, and closing parentheses.
    // The last closing parenthesis precedes state (field 3); starttime is 22.
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    const ticks = stat.slice(end + 1).trim().split(/\s+/)[19];
    return ticks && /^\d+$/.test(ticks) ? `linux:${boot}:${ticks}` : null;
  }
  const options = {
    encoding: "utf8" as const, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4096,
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
  };
  if (process.platform === "win32") {
    const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const ticks = execFileSync(executable, [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_IDENTITY, "utf16le").toString("base64"),
    ], { ...options, env: { ...process.env, COLLIDR_RUNNER_IDENTITY_PID: String(pid) } }).trim();
    return /^\d{18,19}$/.test(ticks) ? `win32:${ticks}` : null;
  }
  if (process.platform === "darwin") {
    const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      ...options, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).trim().replace(/\s+/g, " ");
    // ps exposes seconds, so reuse within one second remains conservative.
    return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(started)
      ? `darwin:${started}` : null;
  }
  return null;
}

/** Capture once when establishing ownership, not on every heartbeat. */
export function captureProcessIdentity(pid: number): string | null {
  if (!validPid(pid)) return null;
  // Only our own PID cannot be reused while this module is running.
  if (pid === process.pid && ownIdentity !== null) return ownIdentity;
  try {
    const identity = queryIdentity(pid);
    if (pid === process.pid && identity !== null) ownIdentity = identity;
    return identity;
  } catch {
    // Missing tools, permission errors, exits during lookup, and timeouts are
    // unknown identity, never proof that the previously owned process exited.
    return null;
  }
}

const nativeProbe: ProcessIdentityProbe = { alive: processAlive, identity: captureProcessIdentity };

/** A birth mismatch releases stale state; it never authorizes killing a PID. */
export function processMatchesIdentity(pid: number, expected: string | null | undefined, probe = nativeProbe): boolean {
  if (!validPid(pid)) return false;
  try {
    if (!probe.alive(pid)) return false;
    // Legacy state has no identity and cannot safely disambiguate PID reuse.
    if (!expected) return true;
    const current = probe.identity(pid);
    return current === null || current === expected;
  } catch {
    return true;
  }
}
