import { parseArgs } from "./lib/args.ts";
import { bold, dim } from "./lib/format.ts";
import { isDirectInvocation } from "./lib/entrypoint.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version;

type CommandHandler = (argv: string[]) => Promise<number>;

type CommandEntry = {
  handler: CommandHandler;
  help: string;
  args?: [string, string][];
  options?: [string, string][];
  /** Flags the command accepts that are too minor for the Options table
   *  (rendered as one compact line instead of one row each). */
  extraFlags?: string[];
  examples?: string[];
  note?: string;
};

const commands: Record<string, CommandEntry> = {
  login: {
    handler: loadCommand("login"),
    help: "Authenticate with email + password",
    options: [
      ["--force", "Re-authenticate even if already logged in"],
      ["--email <addr>", "Pre-fill email (skip prompt)"],
      ["--password <pw>", "Supply password (skip masked prompt)"],
      ["--project <id>", "Skip project picker (id, name, or prefix)"],
    ],
    examples: [
      "apo login",
      "apo login --force",
      "apo login --email me@corp.com --project my-proj",
    ],
    note: "First-time setup — no prior credentials needed. Saves key to ~/.apo/credentials.",
  },
  logout: {
    handler: loadCommand("logout"),
    help: "Clear saved credentials (sign out)",
    note: "Deletes ~/.apo/credentials. No backend connection needed.",
  },
  status: {
    handler: loadCommand("status"),
    help: "Show effective configuration (login, backend, project, task root)",
    note: "Prints exactly what commands will use, resolved from flags > environment > ~/.apo/credentials > defaults. No backend auth needed.",
  },
  "project list": {
    handler: loadCommand("project-list"),
    help: "List projects you can access",
    note: "Requires backend auth. Active project marked with *.",
  },
  "project create": {
    handler: loadCommand("project-create"),
    help: "Create a project and mint an API key from email + password",
    args: [
      ["<name>", "Project name"],
    ],
    options: [
      ["--email <email>", "Account email (required)"],
      ["--password <password>", "Account password (required)"],
      ["--scope <full|ingest>", "API key scope (default: full)"],
      ["--backend <url>", "Backend URL (default: http://localhost:8000)"],
      ["--json", "Machine-readable JSON output"],
    ],
    examples: [
      "apo project create my-project --email me@example.com --password secret",
    ],
    note: "Solves the first-run chicken-and-egg: creates the project and saves credentials in one call, so `apo login` can proceed without a dashboard round-trip.",
  },
  "project use": {
    handler: loadCommand("project-use"),
    help: "Switch the active project",
    args: [
      ["[id|name]", "Project id, name, or unique prefix (optional)"],
    ],
    options: [
      ["--project <id>", "Alternative to positional argument"],
    ],
    examples: [
      "apo project use",
      "apo project use my-project",
    ],
    note: "Opens interactive picker if no argument given. Requires prior login.",
  },
  "task list": {
    handler: loadCommand("task-list"),
    help: "List discovered tasks",
    examples: [
      "apo task list",
      "apo task list --json",
    ],
    note: "Defaults to the backend catalog when a project is set; an explicit --dir (or APO_TASK_ROOT) scans locally instead. The last line names the source.",
  },
  "task show": {
    handler: loadCommand("task-show"),
    help: "Show task details",
    args: [
      ["<task-id>", "Task identifier"],
    ],
    examples: [
      "apo task show meeting-summary",
    ],
    note: "Uses backend (with --project) or local discovery. Supports --json.",
  },
  "task run": {
    handler: loadCommand("task-run"),
    help: "Run a task",
    args: [
      ["<task-id | path>", "Task id or filesystem path"],
    ],
    options: [
      ["--ci", "CI mode: records CI metadata, uses strict exit codes"],
      ["--no-record", "Run on this machine WITHOUT recording (skips the backend entirely)"],
      ["--local", "(compat) accepted no-op — runs are always local now"],
      ["--executor <caller>", "(compat) accepted no-op; any other target is an error"],
    ],
    extraFlags: [
      "ci-actor", "ci-hostname", "ci-system", "ci-run-id", "ci-run-url",
      "repo", "branch", "sha", "pr",
    ],
    examples: [
      "apo task run meeting-summary",
      "apo task run ./tasks/my-task",
      "apo task run meeting-summary --no-record",
      "apo task run bind-e2e --ci",
    ],
    note: "Always executes on this machine (caller execution). Records the run when backend + project + credential are configured; a configured recording that cannot reach the backend exits 2 — use --no-record to skip recording. Exit codes: 0=pass, 1=fail, 2=error.",
  },
  "task publish": {
    handler: loadCommand("task-publish"),
    help: "Publish task metadata to the Apo Task Catalog",
    options: [
      ["--dir <path>", "Task root directory (default: from config)"],
      ["--project <id>", "Project to publish to (default: active project)"],
      ["--dry-run", "Print the publication document without sending"],
      ["--allow-empty", "Required to publish zero tasks (clears catalog)"],
      ["--json", "Machine-readable output"],
    ],
    examples: [
      "apo task publish",
      "apo task publish --dry-run --json",
      "apo task publish --dir ./tasks --project acme",
    ],
    note: "Scans local tasks and publishes bounded metadata only — no source files, prompts, or credentials leave your machine.",
  },
  connect: {
    handler: loadCommand("connect"),
    help: "Connect as a persistent source-owned executor",
    options: [
      ["--dir <path>", "Task root directory (default: from config)"],
      ["--project <id>", "Project to connect to (default: active project)"],
      ["--name <name>", "Display name for this machine"],
      ["--concurrency <n>", "Max parallel tasks (default: 4)"],
    ],
    examples: [
      "apo connect",
      "apo connect --project acme --concurrency 8",
    ],
    note: "Runs in the foreground. Discovers tasks locally, publishes nothing, and executes only assignments matching your published Task Catalog. Source files and credentials never leave your machine.",
  },
  "runs list": {
    handler: loadCommand("runs-list"),
    help: "List past runs from backend",
    options: [
      ["--task <id>", "Filter by task id"],
      ["--status <s>", "Filter by run status"],
      ["--model <m>", "Filter by adapter-reported model (repeatable; OR within model, AND with --effort)"],
      ["--effort <e>", "Filter by adapter-reported effort (repeatable; OR within effort, AND with --model)"],
      ["--limit <n>", "Max results to show"],
    ],
    examples: [
      "apo runs list",
      "apo runs list --task meeting-summary --limit 5",
      "apo runs list --model gpt-5.6-terra --effort high",
    ],
    note: "Requires backend auth. Supports --json. The Execution column shows the adapter-reported model · effort.",
  },
  "runs show": {
    handler: loadCommand("runs-show"),
    help: "Show run details (checks, failures, cost) from backend",
    args: [
      ["[run-id]", "Run ID, unique prefix, or 'last' (default: latest run)"],
    ],
    options: [
      ["--verbose", "Show all assertions (incl. passing) + LLM judge responses"],
      ["--exit-status", "Exit non-zero if the run failed (for CI / scripting)"],
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
    ],
    examples: [
      "apo runs show              # latest run",
      "apo runs show de89cab      # by prefix",
      "apo runs show last --task meeting-summary",
      "apo runs show de89cab --verbose --exit-status",
    ],
    note: "Accepts run-id prefixes. Requires backend auth. Supports --json. Large per-check values (typically the deliverable re-sent per criterion) are shown as a one-line manifest; read full content with `apo runs deliverable <run-id> [name]` (fetches a deliverable once, not per check).",
  },
  "runs deliverable": {
    handler: loadCommand("runs-deliverable"),
    help: "Read a run's deliverables (manifest list, or one deliverable's full content)",
    args: [
      ["<run-id>", "Run ID, unique prefix, or 'last'"],
      ["[name]", "Deliverable name — omit to list all deliverables as a manifest"],
    ],
    options: [
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
      ["--output <path>", "Write a binary artifact to a file instead of stdout. Use '.' to auto-derive the original filename."],
    ],
    examples: [
      "apo runs deliverable de89cab             # manifest of all deliverables",
      "apo runs deliverable de89cab memorandum   # full content of one JSON deliverable",
      "apo runs deliverable de89cab verifier-log --output verifier.log",
      "apo runs deliverable last --task meeting-summary summary",
    ],
    note: "Accepts run-id prefixes. Requires backend auth. Fetches only the manifest, then exactly one body when a name is given — never the whole run. Binary artifacts require --output on an interactive terminal (use '.' to keep the original filename). Supports --json.",
  },
  "traces list": {
    handler: loadCommand("traces-list"),
    help: "List recent traces from backend",
    options: [
      ["--task <id>", "Filter by task id"],
      ["--limit <n>", "Max results (default: 20)"],
    ],
    examples: [
      "apo traces list --limit 10",
    ],
    note: "Requires backend auth. Supports --json.",
  },
  "traces show": {
    handler: loadCommand("traces-show"),
    help: "Show trace call details (timing, cost, tokens)",
    args: [
      ["<trace-id>", "Trace ID or unique prefix"],
    ],
    options: [
      ["--verbose", "Show per-call input/output/messages"],
      ["--errors-only", "Show only error/warning calls"],
    ],
    examples: [
      "apo traces show abc123",
      "apo traces show abc123 --errors-only",
    ],
    note: "Accepts trace-id prefixes. Requires backend auth. Supports --json.",
  },
  "traces import langfuse": {
    handler: loadCommand("traces-import-langfuse"),
    help: "Import a Langfuse trace into apo via the OTLP receiver",
    args: [
      ["<trace-id>", "Langfuse source trace id"],
    ],
    options: [
      ["--langfuse-host <url>", "Override LANGFUSE_HOST"],
      ["--max-observations <count>", "Safety ceiling (default 10000, range 1..50000)"],
      ["--wait <seconds>", "Poll the source until the trace looks fully ingested (quiet observation count + no dangling parent links), not just the first span"],
      ["--settle <seconds>", "Quiet period the observation count must hold before the trace counts as ingested (default 15; only with --wait)"],
      ["--trace-id <apo-trace-id>", "Emit spans under this trace id instead of the namespaced hash (merge into an existing run trace; 32-hex W3C)"],
      ["--parent-span-id <span-id>", "The span in the target trace the imported subtree hangs under (16-hex W3C); lets the completeness check tell an expected external parent from an un-ingested one"],
      ["--json", "Machine-readable LangfuseImportResult JSON"],
    ],
    examples: [
      "apo traces import langfuse 8f38c27a2c4b4bafb87a78e3a3d62b90",
      "apo traces import langfuse <id> --langfuse-host https://us.langfuse.com",
      "apo traces import langfuse <id> --wait 120",
      "apo traces import langfuse <run-trace-id> --trace-id <run-trace-id>",
    ],
    note: "Credentials are environment-only: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (required) and LANGFUSE_HOST (optional). Keys never leave the CLI process. Re-running is safe and idempotent. Exit codes: 0 = imported and visible; 75 = source trace not ready (retryable); 2 = hard error. See the docs page for --wait/--settle ingestion gating and merge mode (--trace-id, --parent-span-id).",
  },
  "batch list": {
    handler: loadCommand("batch-list"),
    help: "List batch runs from backend",
    options: [
      ["--status <s>", "Filter by batch status"],
    ],
    examples: [
      "apo batch list",
    ],
    note: "Requires backend auth. Supports --json.",
  },
  "batch show": {
    handler: loadCommand("batch-show"),
    help: "Show batch run details from backend",
    args: [
      ["<batch-id>", "Batch ID or unique prefix"],
    ],
    options: [
      ["--watch", "Auto-refresh every 3s until complete"],
    ],
    examples: [
      "apo batch show abc123",
      "apo batch show abc123 --watch",
    ],
    note: "Accepts batch-id prefixes. Requires backend auth. Supports --json.",
  },
  reprice: {
    handler: loadCommand("reprice"),
    help: "Re-compute stored call costs against current pricing (history rewrite)",
    options: [
      ["--project <id>", "Scope to a project"],
      ["--model-id <int>", "Scope to calls priced against a specific model row id"],
      ["--since <datetime>", "ISO datetime lower bound on call start (inclusive)"],
      ["--until <datetime>", "ISO datetime upper bound on call start (exclusive)"],
      ["--dry-run", "Recompute without overwriting stored costs"],
      ["--admin-key <key>", "Admin API key (or APO_ADMIN_KEY env)"],
    ],
    examples: [
      "apo reprice",
      "apo reprice --project my-proj --since 2026-01-01T00:00:00Z",
      "apo reprice --model-id 3 --dry-run",
    ],
    note:
      "Operator-only history rewrite. Requires --admin-key (ADMIN_API_KEY on the backend). Provided-cost and pre-migration calls are skipped.",
  },
};

function loadCommand(name: string): CommandHandler {
  return async (argv: string[]) => {
    const mod = await import(`./commands/${name}.ts`);
    return mod.run(argv);
  };
}

/** Flags every command accepts. */
const GLOBAL_FLAGS = new Set([
  "help", "h", "version", "v", "json",
  "dir", "backend", "project", "actor", "api-key",
]);

function validFlagNames(entry: CommandEntry): Set<string> {
  const names = new Set(GLOBAL_FLAGS);
  for (const [flag] of entry.options ?? []) {
    const name = flag.split(/\s+/)[0];
    if (name.startsWith("--")) {
      names.add(name.slice(2));
    }
  }
  for (const name of entry.extraFlags ?? []) {
    names.add(name);
  }
  return names;
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(`apo ${VERSION}`);
    return 0;
  }

  const matched = positional.length > 0 ? findCommand(positional) : null;

  if (flags.help) {
    if (matched) {
      printCommandHelp(matched.key, commands[matched.key]);
    } else {
      printHelp();
    }
    return 0;
  }

  if (!matched) {
    if (positional.length > 0) {
      console.error(`Unknown command: ${positional.join(" ")}`);
      console.error("");
      printHelp();
      return 2;
    }
    for (const key of Object.keys(flags)) {
      if (!GLOBAL_FLAGS.has(key)) {
        console.error(`Unknown option: --${key}`);
        console.error("Run 'apo --help' for the full list.");
        return 2;
      }
    }
    printHelp();
    return 0;
  }

  const command = commands[matched.key];

  // Reject mistyped flags loudly: a silently-dropped --projct or --statu
  // filter is confidently-wrong output, not an error an agent can see.
  const accepted = validFlagNames(command);
  for (const key of Object.keys(flags)) {
    if (!accepted.has(key)) {
      console.error(`Unknown option: --${key} (apo ${matched.key})`);
      console.error(`Run 'apo ${matched.key} --help' for the valid options.`);
      return 2;
    }
  }

  const commandArgs = positional.slice(matched.keyParts.length);
  for (const [key, value] of Object.entries(flags)) {
    if (key === "help" || key === "version") continue;
    if (typeof value === "string") {
      commandArgs.push(`--${key}`, value);
    } else if (value === true) {
      commandArgs.push(`--${key}`);
    }
  }
  return command.handler(commandArgs);
}

function findCommand(positional: string[]): { key: string; keyParts: string[] } | null {
  const entries = Object.keys(commands)
    .map((key) => ({ key, keyParts: key.split(" ") }))
    .sort((left, right) => right.keyParts.length - left.keyParts.length);

  for (const entry of entries) {
    if (entry.keyParts.length > positional.length) {
      continue;
    }
    if (entry.keyParts.every((part, index) => positional[index] === part)) {
      return entry;
    }
  }

  return null;
}

function pad(label: string, width: number): string {
  return label.padEnd(width + 2);
}

function printCommandHelp(key: string, entry: CommandEntry): void {
  const head = `apo ${key}`;
  console.log(bold(head));
  console.log(`  ${entry.help}`);
  console.log("");

  console.log(bold("Usage:"));
  const argSummary = entry.args?.map((a) => a[0]).join(" ") ?? "";
  const optSummary = entry.options?.length ? " [options]" : "";
  console.log(`  apo ${key}${argSummary ? ` ${argSummary}` : ""}${optSummary}`);
  console.log("");

  if (entry.args?.length) {
    console.log(bold("Arguments:"));
    const w = Math.max(...entry.args.map((a) => a[0].length));
    for (const [name, desc] of entry.args) {
      console.log(`  ${pad(name, w)} ${desc}`);
    }
    console.log("");
  }

  if (entry.options?.length) {
    console.log(bold("Options:"));
    const w = Math.max(...entry.options.map((o) => o[0].length));
    for (const [flag, desc] of entry.options) {
      console.log(`  ${pad(flag, w)} ${desc}`);
    }
    console.log("");
  }

  if (entry.extraFlags?.length) {
    console.log(dim(`Also accepted: ${entry.extraFlags.map((f) => `--${f}`).join(", ")}`));
    console.log("");
  }

  if (entry.examples?.length) {
    console.log(bold("Examples:"));
    for (const ex of entry.examples) {
      console.log(`  ${ex}`);
    }
    console.log("");
  }

  if (entry.note) {
    console.log(dim(entry.note));
    console.log("");
  }

  console.log(dim("Global flags: --backend, --project, --json, --dir, --actor, --api-key"));
  console.log(dim("Run 'apo --help' for the full list."));
}

function printHelp(): void {
  console.log(bold("apo — Agent Task Runner"));
  console.log("");
  console.log(bold("Quick start:"));
  console.log("  apo login                Authenticate");
  console.log("  apo project use          Pick a project");
  console.log("  apo task list            See available tasks");
  console.log("  apo task run <task-id>   Run a task");
  console.log("  apo runs show <run-id>   Inspect results + failures");
  console.log("");
  console.log(bold("Commands:"));
  console.log("");

  const entries = Object.entries(commands);
  const maxWidth = Math.max(...entries.map(([k]) => k.length));

  for (const [name, entry] of entries) {
    console.log(`  ${name.padEnd(maxWidth + 2)} ${entry.help}`);
  }

  console.log("");
  console.log(bold("Global Flags:"));
  console.log("  --dir <path>       Task root directory (default: ./e2e)");
  console.log("  --backend <url>    Backend URL (default: http://localhost:8000)");
  console.log("  --project <id>     Project ID");
  console.log("  --actor <name>     Actor name recorded in run metadata");
  console.log("  --api-key <key>    API key (default: read from $APO_API_KEY or ~/.apo/credentials)");
  console.log("  --json             Machine-readable JSON output");
  console.log("  --help             Show help (use 'apo <command> --help' for per-command details)");
  console.log("  --version          Show version");
  console.log("");
  console.log(bold("Environment variables:"));
  console.log("  APO_TASK_ROOT      Default task root directory");
  console.log("  APO_BACKEND_URL    Default backend URL");
  console.log("  APO_PROJECT_ID     Default project ID");
  console.log("  APO_ACTOR          Default actor name");
  console.log("  APO_API_KEY        API key for backend auth");
}

// Only run when invoked directly as the entry point (not when imported, e.g.
// by tests). Without this guard the side-effect below would fire on import.
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      // Force exit: Node's global fetch (undici) keeps its connection pool
      // alive, which would otherwise hold the event loop open and hang the CLI
      // after any network command.
      process.exit(code);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(2);
    });
}
