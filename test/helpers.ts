import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { Store } from "../src/store.js";
import type { Actor } from "../src/types.js";

export interface Hub {
  dir: string;
  file: string;
  store: Store;
  workspaceId: string;
  claude: Actor;
  codex: Actor;
  gemini: Actor;
  /** A second Store on the same file, standing in for another process. */
  reopen(): Store;
  close(): void;
}

let counter = 0;

export function makeHub(): Hub {
  const dir = mkdtempSync(join(tmpdir(), "collidr-test-"));
  const file = join(dir, "hub.db");
  const opened: Store[] = [];
  const open = () => {
    const s = new Store(openDatabase(file));
    opened.push(s);
    return s;
  };
  const store = open();
  const ws = store.ensureWorkspace("/repo/collidr", "https://github.com/average04/collidr.git");
  const reg = (id: string, client: string, model: string): Actor => {
    const { participant, session } = store.register({ participantId: id, client, model, role: "agent" });
    return { participantId: participant.id, sessionId: session.id };
  };
  return {
    dir,
    file,
    store,
    workspaceId: ws.id,
    claude: reg("claude-author", "claude-code", "claude-opus-5-5"),
    codex: reg("codex-reviewer", "codex-cli", "gpt-codex"),
    gemini: reg("gemini-reviewer", "gemini-cli", "gemini-pro"),
    reopen: open,
    close() {
      for (const s of opened) s.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function key(label = "k"): string {
  counter += 1;
  return `${label}-${counter}`;
}

export const PATCH_R1 = [
  "diff --git a/src/sum.ts b/src/sum.ts",
  "--- a/src/sum.ts",
  "+++ b/src/sum.ts",
  "@@ -1,3 +1,3 @@",
  " export function sum(a: number, b: number) {",
  "-  return a - b;",
  "+  return a + b;",
  " }",
].join("\n");

export const PATCH_R2 = PATCH_R1 + "\n+// handles negatives too";
