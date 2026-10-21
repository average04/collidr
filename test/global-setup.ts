import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/** Multi-process tests spawn plain Node workers that import the compiled build. */
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
