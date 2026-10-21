/**
 * Error codes are part of Collidr's public contract (spec §7). Agents branch on
 * `code`, so codes must never be renamed once released.
 */
export const ERROR_CODES = [
  "idempotency_conflict",
  "thread_closed",
  "stale_revision",
  "round_limit_reached",
  "verdict_required",
  "not_assignee",
  "request_not_open",
  "no_reviewers",
  "content_too_large",
  "workspace_unresolved",
  "not_found",
  "not_participant",
  "forbidden",
  "invalid_argument",
  "sqlite_too_old",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CollidrError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CollidrError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function isCollidrError(err: unknown): err is CollidrError {
  return err instanceof CollidrError;
}
