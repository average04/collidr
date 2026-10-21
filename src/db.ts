import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CollidrError } from "./errors.js";
import { MIGRATIONS } from "./schema.js";

export type DB = Database.Database;

/** WAL-reset fix landed in 3.51.3 (spec §8). */
export const MIN_SQLITE_VERSION: readonly [number, number, number] = [3, 51, 3];

export function defaultDatabasePath(): string {
  return process.env.COLLIDR_DB ?? join(homedir(), ".collidr", "hub.db");
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function sqliteVersion(db: DB): string {
  return (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
}

export interface OpenOptions {
  /** Milliseconds to wait for a write lock before failing. */
  busyTimeoutMs?: number;
}

/**
 * Open (and migrate) the hub database. Every Collidr process opens the same file;
 * WAL lets readers run alongside the single writer.
 */
export function openDatabase(file: string = defaultDatabasePath(), opts: OpenOptions = {}): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);

  const version = sqliteVersion(db);
  if (compareVersions(version.split(".").map(Number), MIN_SQLITE_VERSION) < 0) {
    db.close();
    throw new CollidrError(
      "sqlite_too_old",
      `SQLite ${version} is older than the required ${MIN_SQLITE_VERSION.join(".")} (WAL-reset fix).`,
      { version },
    );
  }

  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

/**
 * Apply pending migrations under an exclusive lock, so two processes starting at
 * the same time can't migrate twice. The version is re-read inside the lock.
 */
export function migrate(db: DB): void {
  db.transaction(() => {
    const current = db.pragma("user_version", { simple: true }) as number;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
  }).exclusive();
}
