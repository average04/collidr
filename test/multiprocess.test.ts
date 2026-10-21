import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCH_R1, PATCH_R2, key, makeHub, type Hub } from "./helpers.js";

const WORKER = fileURLToPath(new URL("./fixtures/race-worker.mjs", import.meta.url));

interface WorkerResult {
  ok: boolean;
  result?: Record<string, unknown>;
  code?: string;
}

/** Start N separate Node processes, release them together, collect their results. */
async function race(file: string, dir: string, jobs: { op: string; args: unknown }[]): Promise<WorkerResult[]> {
  const go = join(dir, `go-${Math.random().toString(36).slice(2)}`);
  const runs = jobs.map(
    (job) =>
      new Promise<WorkerResult>((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER, file, job.op, JSON.stringify(job.args), go]);
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`worker exited ${code}: ${err}`));
          else resolve(JSON.parse(out) as WorkerResult);
        });
      }),
  );
  // Give every worker time to open the database, then release them at once.
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(go, "");
  return Promise.all(runs);
}

let hub: Hub;
beforeEach(() => {
  hub = makeHub();
});
afterEach(() => hub.close());

function openThread() {
  return hub.store.openThread(hub.claude, {
    idempotencyKey: key("open"),
    workspaceId: hub.workspaceId,
    type: "diff_review",
    title: "race",
    reviewers: [hub.codex.participantId],
    contentType: "patch",
    content: PATCH_R1,
  });
}

describe("concurrent processes", () => {
  it("four concurrent retries of submit_revision create exactly one revision", async () => {
    const t = openThread();
    const input = { idempotencyKey: "rev-2", threadId: t.thread_id, contentType: "patch", content: PATCH_R2 };
    const results = await race(
      hub.file,
      hub.dir,
      Array.from({ length: 4 }, () => ({ op: "submit_revision", args: { actor: hub.claude, input } })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => r.result!.revision_id));
    expect(ids.size).toBe(1);
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE thread_id = ?").get(t.thread_id)).toEqual({
      n: 2,
    });
  });

  it("submit_revision racing resolve: exactly one succeeds", async () => {
    const t = openThread();
    const results = await race(hub.file, hub.dir, [
      {
        op: "submit_revision",
        args: {
          actor: hub.claude,
          input: { idempotencyKey: "race-rev", threadId: t.thread_id, contentType: "patch", content: PATCH_R2 },
        },
      },
      {
        op: "resolve",
        args: {
          actor: hub.claude,
          input: {
            idempotencyKey: "race-resolve",
            threadId: t.thread_id,
            expectedRevisionId: t.revision_id,
            outcome: "unresolved",
            summary: "racing",
          },
        },
      },
    ]);
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    const failed = results.find((r) => !r.ok)!;
    expect(["thread_closed", "stale_revision"]).toContain(failed.code);
  });
});
