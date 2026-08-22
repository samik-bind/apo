import { existsSync } from "fs";
import { parseArgs } from "../lib/args.ts";
import { isBackendReachable } from "../lib/api.ts";
import { credentialsPath, readCredentials } from "../lib/credentials.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, green, red, yellow } from "../lib/format.ts";

/**
 * Print the configuration every command will actually use. The effective
 * task root and backend live in ~/.apo/credentials after `apo login`, which
 * is invisible otherwise — this surfaces them (and whether they exist).
 */
export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const stored = readCredentials();

  const reachable = await isBackendReachable(config.backendUrl);
  const rootExists = existsSync(config.taskRoot);

  console.log(bold("apo status"));
  console.log(`  Login:      ${stored?.email ?? dim("not logged in (run: apo login)")}`);
  console.log(`  Backend:    ${config.backendUrl} ${reachable ? green("✓ reachable") : red("✗ unreachable")}`);
  console.log(`  Project:    ${config.projectId ?? dim("(none — run: apo project use)")}`);
  console.log(`  Task root:  ${config.taskRoot} ${rootExists ? "" : yellow("(directory does not exist)")}`);
  console.log("");
  console.log(dim(`Credentials: ${credentialsPath()}${stored ? "" : " (absent)"}`));
  console.log(dim("Task resolution: task run reads the task root; task list defaults to the backend catalog when a project is set (task list --dir scans locally)."));

  return 0;
}
