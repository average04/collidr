// Spawned by multiprocess tests: opens the shared hub file in a separate process,
// waits for a start signal file, then performs one mutation and prints the result.
import { existsSync } from "node:fs";
import { openDatabase, Store } from "../../dist/index.js";

const [file, op, json, goFile] = process.argv.slice(2);
const args = JSON.parse(json);
const store = new Store(openDatabase(file));

while (!existsSync(goFile)) {
  await new Promise((r) => setTimeout(r, 2));
}

try {
  const result = op === "open_thread" ? store.openThread(args.actor, args.input)
    : op === "submit_revision" ? store.submitRevision(args.actor, args.input)
    : op === "resolve" ? store.resolve(args.actor, args.input)
    : op === "post" ? store.post(args.actor, args.input)
    : (() => { throw new Error(`unknown op ${op}`); })();
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, code: err.code ?? "error", message: err.message }));
} finally {
  store.db.close();
}
