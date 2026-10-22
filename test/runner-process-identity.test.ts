import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureProcessIdentity, processAlive, processMatchesIdentity } from "../src/runner/process-identity.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("runner process identity", () => {
  it("captures a stable birth identity for this process", () => {
    const identity = captureProcessIdentity(process.pid);
    expect(identity).toEqual(expect.any(String));
    expect(processAlive(process.pid)).toBe(true);
    expect(processMatchesIdentity(process.pid, identity)).toBe(true);
    expect(captureProcessIdentity(process.pid)).toBe(identity);
  }, 15_000);

  it("recognizes a dead PID and rejects process-group or invalid PIDs", () => {
    for (const pid of [2147483647, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(captureProcessIdentity(pid)).toBeNull();
      expect(processAlive(pid)).toBe(false);
      expect(processMatchesIdentity(pid, "old-birth")).toBe(false);
    }
  }, 10_000);

  it("identifies a reused PID without signaling the replacement process", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(processMatchesIdentity(100, "old-birth", {
      alive: () => true, identity: () => "new-birth",
    })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps uncertain and legacy process identities occupied", () => {
    const unknown = { alive: () => true, identity: () => null };
    expect(processMatchesIdentity(100, "old-birth", unknown)).toBe(true);
    expect(processMatchesIdentity(100, null, unknown)).toBe(true);
    expect(processMatchesIdentity(100, undefined, unknown)).toBe(true);
    expect(processMatchesIdentity(100, "old-birth", {
      alive: () => true, identity: () => { throw Object.assign(new Error("Denied"), { code: "EPERM" }); },
    })).toBe(true);
  });

  it("treats permission failure as alive and only ESRCH as dead", () => {
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation(() => { throw Object.assign(new Error("Denied"), { code: "EPERM" }); });
    expect(processAlive(100)).toBe(true);
    kill.mockImplementation(() => { throw Object.assign(new Error("Gone"), { code: "ESRCH" }); });
    expect(processAlive(100)).toBe(false);
  });

  it("does not interpret a process disappearing during identity lookup as a birth mismatch", () => {
    expect(processMatchesIdentity(100, "old-birth", {
      alive: () => true, identity: () => null,
    })).toBe(true);
    expect(processMatchesIdentity(100, "old-birth", {
      alive: () => false, identity: () => { throw new Error("No identity lookup needed"); },
    })).toBe(false);
  });

  it("extracts Linux start ticks even when a process name contains spaces and parentheses", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      if (file === "/proc/sys/kernel/random/boot_id") return "01234567-89ab-cdef-0123-456789abcdef\n";
      if (file === "/proc/100/stat") return "100 (a tricky ) process) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 34567 20 21\n";
      throw new Error("Unexpected file");
    });
    expect(captureProcessIdentity(100)).toBe("linux:01234567-89ab-cdef-0123-456789abcdef:34567");
  });

  it("returns unknown for malformed or inaccessible Linux identity data", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const read = vi.spyOn(fs, "readFileSync");
    read.mockReturnValue("malformed");
    expect(captureProcessIdentity(100)).toBeNull();
    read.mockImplementation(() => { throw Object.assign(new Error("Denied"), { code: "EACCES" }); });
    expect(captureProcessIdentity(100)).toBeNull();
  });

  it("parses Windows creation ticks and treats failed or malformed output as unknown", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const execute = vi.spyOn(childProcess, "execFileSync");
    execute.mockReturnValue("638966688001234567\r\n");
    expect(captureProcessIdentity(100)).toBe("win32:638966688001234567");
    const [, , options] = execute.mock.calls[0]!;
    expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: expect.any(Number) });
    expect((options as childProcess.ExecFileSyncOptions).timeout).toBeLessThanOrEqual(3000);
    execute.mockReturnValue("638966688001234567\nwarning");
    expect(captureProcessIdentity(100)).toBeNull();
    execute.mockImplementation(() => { throw new Error("Probe timed out"); });
    expect(captureProcessIdentity(100)).toBeNull();
  });

  it("normalizes macOS ps start times and fixes locale and timezone", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const execute = vi.spyOn(childProcess, "execFileSync").mockReturnValue("Thu Oct  1 04:05:06 2026\n");
    expect(captureProcessIdentity(100)).toBe("darwin:Thu Oct 1 04:05:06 2026");
    expect(execute.mock.calls[0]?.[0]).toBe("/bin/ps");
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }) });
    execute.mockReturnValue("unknown process");
    expect(captureProcessIdentity(100)).toBeNull();
  });
});
