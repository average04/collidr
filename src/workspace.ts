import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CollidrError } from "./errors.js";
import type { Store } from "./store.js";
import type { Workspace } from "./types.js";

/** Walk up from `start` to the nearest directory containing `.git` (dir or worktree file). */
export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Best-effort read of `remote "origin"` from .git/config; null when unavailable. */
export function readOriginUrl(repoRoot: string): string | null {
  try {
    const gitPath = join(repoRoot, ".git");
    if (!statSync(gitPath).isDirectory()) return null; // worktrees/submodules: skip
    const config = readFileSync(join(gitPath, "config"), "utf8");
    const section = /\[remote "origin"\]([^[]*)/.exec(config);
    const url = section && /^\s*url\s*=\s*(.+)$/m.exec(section[1]!);
    return url ? url[1]!.trim() : null;
  } catch {
    return null;
  }
}

/** Canonical form so the same repo always maps to the same workspace. */
export function normalizeRoot(path: string): string {
  const abs = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Workspace resolution (spec §7): explicit argument (a workspace ID or a path
 * inside a repository) wins, then COLLIDR_WORKSPACE, then the git root of the
 * server's working directory. Never guesses beyond that.
 */
export function resolveWorkspace(store: Store, explicit?: string, cwd: string = process.cwd()): Workspace {
  if (explicit && ULID.test(explicit)) {
    try {
      return store.getWorkspace(explicit);
    } catch {
      // not a known ID; fall through and treat it as a path
    }
  }
  const candidate = explicit ?? process.env.COLLIDR_WORKSPACE ?? cwd;
  const root = findGitRoot(candidate) ?? (explicit || process.env.COLLIDR_WORKSPACE ? resolve(candidate) : null);
  if (!root || !existsSync(root)) {
    throw new CollidrError(
      "workspace_unresolved",
      "could not determine the workspace: pass `workspace` (a repository path), set COLLIDR_WORKSPACE, or run inside a git repository",
      { tried: candidate },
    );
  }
  return store.ensureWorkspace(normalizeRoot(root), readOriginUrl(root) ?? undefined);
}
