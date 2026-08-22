import { parseArgs } from "../lib/args.ts";
import { dim, green } from "../lib/format.ts";
import {
  clearCredentials,
  credentialsPath,
  forgetRememberedLogin,
  readCredentials,
} from "../lib/credentials.ts";

export async function run(argv: string[]): Promise<number> {
  parseArgs(argv);
  const existing = readCredentials();
  const removed = clearCredentials();
  if (!removed) {
    console.log(dim("Not logged in."));
    return 0;
  }
  // A real sign-out removes the remembered login too — otherwise a valid API
  // key would survive `apo logout` in ~/.apo/logins/.
  if (existing?.backend_url) {
    forgetRememberedLogin(existing.backend_url);
  }
  console.log(green(`\u2713 Logged out${existing?.email ? ` (${existing.email})` : ""}.`));
  console.log(dim(`  Removed: ${credentialsPath()}`));
  return 0;
}
