/**
 * PROTOTYPE ONLY — real-data layer for the "apo for humans" prototype.
 * The interesting, liftable bit: task discovery, a model list derived from
 * the pricing catalog, and a READ-ONLY env resolver that mirrors
 * task-run.ts's loadEnvFiles chain (first-wins files, process.env wins)
 * without ever holding a secret value — only names, set/missing, source.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../../src/lib/config.ts";
import { discoverTaskMeta, type TaskMeta } from "../../src/lib/task-meta.ts";

export type ModelOption = {
  /** A runnable-looking id synthesized from the pricing match_pattern. */
  id: string;
  display: string;
  provider: string;
  input: number;
  output: number;
};

export type SharedState = {
  tasks: TaskMeta[];
  taskSource: string;
  models: ModelOption[];
  modelSource: string;
  /** Survives variant switches — the whole point of Tab-ing between shells. */
  selection: { taskId?: string; model?: string };
  cursor: number;
};

export type EnvVarState = {
  name: string;
  set: boolean;
  /** "process env" or the .env file path that would supply it. */
  source: string | null;
};

export type EnvView = {
  /** The .env chain for this task dir, in resolution order. */
  files: { path: string; exists: boolean }[];
  known: (EnvVarState & { meaning: string })[];
  /** Everything else the chain provides — names only, never values. */
  others: string[];
};

/** The env vars the apo runtime/CLI actually reads (task-runtime.ts + config.ts). */
export const KNOWN_VARS: { name: string; meaning: string }[] = [
  { name: "OPENROUTER_MODEL", meaning: "model id via OpenRouter (takes precedence)" },
  { name: "OPENAI_MODEL", meaning: "model id via OpenAI-compatible API" },
  { name: "OPENROUTER_API_KEY", meaning: "OpenRouter auth" },
  { name: "OPENAI_API_KEY", meaning: "OpenAI(-compatible) auth" },
  { name: "OPENROUTER_BASE_URL", meaning: "OpenRouter base URL override" },
  { name: "OPENAI_BASE_URL", meaning: "OpenAI-compatible base URL override" },
  { name: "AGENT_TASK_JUDGE_MODEL", meaning: "default judge model for `runs rejudge`" },
  { name: "AGENT_TASK_ENVIRONMENT", meaning: "environment label recorded on runs" },
  { name: "APO_TASK_ROOT", meaning: "CLI: where tasks live" },
  { name: "APO_BACKEND_URL", meaning: "CLI: apo backend URL" },
];

export async function loadShared(): Promise<SharedState> {
  const config = resolveConfig({});
  let tasks: TaskMeta[] = [];
  let taskSource = `scanned ${config.taskRoot}`;
  if (existsSync(config.taskRoot)) {
    try {
      tasks = discoverTaskMeta(config.taskRoot);
    } catch {
      tasks = [];
    }
  }
  if (tasks.length === 0) {
    tasks = SAMPLE_TASKS;
    taskSource = "SAMPLE DATA (no task root found)";
  }

  const models = loadModels();
  return {
    tasks,
    taskSource,
    models: models.models,
    modelSource: models.source,
    selection: {},
    cursor: 0,
  };
}

function loadModels(): { models: ModelOption[]; source: string } {
  const url = new URL("../../../../backend/apo/data/default-model-prices.json", import.meta.url);
  const path = fileURLToPath(url);
  if (!existsSync(path)) {
    return { models: SAMPLE_MODELS, source: "SAMPLE DATA (pricing catalog not found)" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      models: {
        match_pattern: string;
        provider: string;
        display_name: string;
        pricing_tiers: { is_default?: boolean; prices: { input: number; output: number } }[];
      }[];
    };
    const models = parsed.models
      .map((m) => {
        const tier = m.pricing_tiers.find((t) => t.is_default) ?? m.pricing_tiers[0];
        return {
          id: idFromPattern(m.match_pattern),
          display: m.display_name,
          provider: m.provider,
          input: tier?.prices.input ?? 0,
          output: tier?.prices.output ?? 0,
        };
      })
      // date-tiered patterns share a display name — keep the first tier only
      .filter((m, i, arr) => arr.findIndex((x) => x.display === m.display) === i);
    return { models, source: `pricing catalog (${models.length} patterns)` };
  } catch {
    return { models: SAMPLE_MODELS, source: "SAMPLE DATA (catalog unreadable)" };
  }
}

/** "(?i)^claude-sonnet-4[.-]5.*$" -> "claude-sonnet-4-5" — good enough for a picker. */
function idFromPattern(pattern: string): string {
  return pattern
    .replace(/^\(\?i\)/, "")
    .replace(/^\^/, "")
    .replace(/\.\*\$$/, "")
    .replace(/\.\*$/, "")
    .replace(/\$$/, "")
    .replace(/\[\.-\]/g, "-")
    .replace(/\\/g, "");
}

/**
 * Pure, read-only version of task-run.ts's loadEnvFiles: same candidate
 * chain, same first-wins semantics (process.env wins, files never override
 * each other), but nothing is mutated and no value is returned.
 */
export function resolveEnvView(
  taskDir: string,
  processEnv: Record<string, string | undefined>,
): EnvView {
  const candidates = [
    resolve(taskDir, ".env"),
    resolve(taskDir, "../../.env"),
    resolve(process.cwd(), "backend/.env"),
    resolve(process.cwd(), "apps/example-service/.env"),
    resolve(process.cwd(), ".env"),
  ];

  const found = new Map<string, string>(); // key -> source file (first wins)
  const files = candidates.map((path) => ({ path, exists: existsSync(path) }));
  for (const { path, exists } of files) {
    if (!exists) continue;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!found.has(key)) found.set(key, path);
      }
    } catch {
      // unreadable file — same tolerance as the real loader
    }
  }

  const stateFor = (name: string): EnvVarState => {
    if (processEnv[name] !== undefined) return { name, set: true, source: "process env" };
    const from = found.get(name);
    return from !== undefined ? { name, set: true, source: from } : { name, set: false, source: null };
  };

  const knownNames = new Set(KNOWN_VARS.map((v) => v.name));
  const others = [...found.keys()].filter((k) => !knownNames.has(k) && processEnv[k] === undefined);

  return {
    files,
    known: KNOWN_VARS.map((v) => ({ ...stateFor(v.name), meaning: v.meaning })),
    others,
  };
}

/** Which model would a run actually use right now, given this env view? */
export function effectiveModel(view: EnvView, selection: { model?: string }): string | null {
  if (selection.model) return selection.model;
  const or = view.known.find((v) => v.name === "OPENROUTER_MODEL");
  const oa = view.known.find((v) => v.name === "OPENAI_MODEL");
  if (or?.set) return "OPENROUTER_MODEL (already set)";
  if (oa?.set) return "OPENAI_MODEL (already set)";
  return null;
}

export function hasProviderKey(view: EnvView): boolean {
  return view.known.some((v) => v.name.endsWith("_API_KEY") && v.set);
}

const SAMPLE_TASKS: TaskMeta[] = [
  task("real-agent/engineering/code-review", "claudeAgent"),
  task("real-agent/engineering/bug-triage", "claudeAgent"),
  task("real-agent/security/security-audit", "claudeAgent"),
  task("real-agent/research/research-synthesis", "claudeAgent"),
  task("ai-sdk-agent/data-extraction", "aiSdkAgent"),
  task("harbor/terminal-bench/count-dataset-tokens", "harbor"),
];

function task(id: string, adapter: string): TaskMeta {
  return {
    id,
    folderPath: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "",
    adapter,
    hasChecks: true,
    path: `/sample/${id}`,
    evalFileName: "task.eval.ts",
    deliverables: ["summary"],
    files: [],
  };
}

const SAMPLE_MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-5", display: "Claude Sonnet 4.5", provider: "anthropic", input: 3.0, output: 15.0 },
  { id: "claude-opus-4-6", display: "Claude Opus 4.6", provider: "anthropic", input: 5.0, output: 25.0 },
  { id: "gpt-5.2", display: "GPT-5.2", provider: "openai", input: 2.5, output: 10.0 },
  { id: "gemini-3-pro", display: "Gemini 3 Pro", provider: "google", input: 2.0, output: 12.0 },
];
