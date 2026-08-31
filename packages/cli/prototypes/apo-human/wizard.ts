/**
 * PROTOTYPE ONLY — variant 1/3: a guided "run an eval" wizard. Four steps,
 * every screen re-rendered whole, every choice remembered across variant
 * switches. Answers: does step-by-step guidance kill the memorization tax?
 */
import { bold, cyan, dim, formatTable, green, red, yellow } from "../../src/lib/format.ts";
import {
  checksHint,
  effectiveModel,
  hasProviderKey,
  modelTree,
  resolveEnvView,
  selectedTasks,
  type ModelChoice,
  type SharedState,
  type TaskCard,
} from "./data.ts";
import { askText, bottomBar, pickTree, waitKey, type PickResult, type TreeNode } from "./ui.ts";

export type VariantResult = "switch" | "quit";

export async function runWizard(shared: SharedState): Promise<VariantResult> {
  let step = 0;
  while (true) {
    // One screen, a collapsible multi-select tree: space checks tasks (or a
    // whole folder subtree), Enter/c confirms the checked subset. Expansion
    // and checks persist across steps.
    if (step === 0) {
      if (shared.selection.taskId) {
        let prefix = "";
        for (const segment of shared.selection.taskId.split("/").slice(0, -1)) {
          prefix = prefix ? `${prefix}/${segment}` : segment;
          shared.treeExpanded.add(prefix);
        }
      }
      const checkedCount = shared.treeChecked.size;
      const result = await pickTree(
        bold("Run an eval") +
          dim(`   [→] open [←] close [space] check${checkedCount > 0 ? ` (${checkedCount})` : ""} [enter] run`),
        shared.tree,
        shared.treeExpanded,
        shared.treeChecked,
      );
      const next = applyPick(result);
      if (next === "switch" || next === "quit") return next;
      if (next !== "back") {
        shared.selection.taskIds = next.map((t) => t.id);
        shared.selection.taskId = next[0]?.id;
        step = 1;
      }
      continue;
    }

    if (step === 1) {
      const current = effectiveModel(resolveEnvView(task(shared).path, process.env), shared.selection);
      const result = await pickTree(
        bold("Model") + dim("   [→] open [esc] back"),
        modelTree(shared.models, current ?? "no model set yet"),
        shared.modelExpanded,
        new Set<string>(),
        { single: true, filter: true },
      );
      const next = applyPick<ModelChoice[]>(result);
      if (next === "switch" || next === "quit") return next;
      if (next === "back") { step = 0; continue; }
      const choice = next[0]!;
      if (choice.kind === "custom") {
        shared.selection.model = await askText("model id", shared.models[0]?.id ?? "");
      } else if (choice.kind === "catalog") {
        shared.selection.model = choice.id;
      } else {
        delete shared.selection.model;
      }
      step = 2;
      continue;
    }

    // The final check: the run manifest — tasks, model, the command — plus
    // one plain-language go/no-go line. Everything env-related that users
    // don't choose (keys, judge wiring) collapses into that line, with the
    // full audit one [d] away.
    if (step === 2) {
      console.clear();
      console.log(`${bold("Ready to run")}\n\n${summaryText(shared)}\n${readinessLine(shared)}`);
      console.log(bottomBar(0) + dim("   [Enter] run · [d] details · [b] back"));
      const key = await waitKey();
      if (key.name === "tab") return "switch";
      if (key.name === "q") return "quit";
      if (key.name === "d") {
        console.clear();
        console.log(`${bold("Environment — details")}\n\n${envScreenText(shared)}`);
        console.log(dim("\n[any key] back"));
        await waitKey();
        continue;
      }
      if (key.name === "b" || key.name === "escape") {
        step = 1;
        continue;
      }
      if (key.name === "return" || key.name === "enter") {
        const count = selectedTasks(shared).length;
        console.log(`\n${dim(`PROTOTYPE — dry run. This is where the ${count} eval(s) would execute`)}`);
        console.log(dim("and record to your project. Wire exec in when this graduates from prototype."));
        await waitKey();
        step = 0;
      }
      continue;
    }
  }
}

/** Narrow a PickResult into a plain control-flow or value token. */
function applyPick<T>(result: PickResult<T>): "switch" | "quit" | "back" | T {
  if (result.kind === "switch") return "switch";
  if (result.kind === "back") return "back";
  return result.value;
}

export function task(shared: SharedState) {
  return shared.tasks.find((t) => t.id === shared.selection.taskId) ?? shared.tasks[0]!;
}

/**
 * One plain-language go/no-go line for the final screen. Users don't pick
 * keys or judges, so those collapse here into a sentence — green says
 * what checks passed, red says what to do about it. The full audit
 * (chain, var table, judge wiring) stays one [d] away.
 */
export function readinessLine(shared: SharedState): string {
  const view = resolveEnvView(task(shared).path, process.env);
  const modelOk =
    shared.selection.model !== undefined ||
    view.known.some((v) => (v.name === "OPENROUTER_MODEL" || v.name === "OPENAI_MODEL") && v.set);
  const keyOk = view.known.some((v) => v.name.endsWith("_API_KEY") && v.set);
  if (modelOk && keyOk) return green("✓ ready to run — model and API key found");
  if (!modelOk) return red("✗ no model selected — press [b] and pick one");
  return red("✗ no API key found — add OPENROUTER_API_KEY or OPENAI_API_KEY to a .env file, then come back");
}

/** The full audit — the [d] details view behind the verdict screen. */
export function envScreenText(shared: SharedState): string {
  const view = resolveEnvView(task(shared).path, process.env);
  const CHAIN_LABELS = ["task .env", "tasks/.env", "backend/.env", "example-service/.env", "repo .env"];
  const chain = view.files
    .map((f, i) => {
      const label = CHAIN_LABELS[i] ?? shortPath(f.path);
      return f.exists ? `${green("✓")} ${label}` : `${dim("·")} ${dim(label)}  ${dim("missing")}`;
    })
    .join("\n  ");
  const rows = view.known.map((v) => [
    v.name,
    dim(v.meaning),
    v.set ? green(`set · ${sourceLabel(v.source)}`) : dim("—"),
  ]);
  const parts = [
    `${bold(".env chain")} ${dim("(first wins, never overrides process env)")}\n  ${chain}`,
    formatTable(["var", "what it does", "state"], rows),
  ];
  if (view.others.length > 0) {
    const shown = view.others.slice(0, 8).join(dim(", "));
    const more = view.others.length > 8 ? dim(` … +${view.others.length - 8} more`) : "";
    parts.push(
      `${bold("other vars your .env provides")} ${dim("(names only — values never shown)")}\n  ${shown}${more}`,
    );
  }
  if (!hasProviderKey(view)) {
    parts.push(yellow("⚠ no OPENROUTER_API_KEY / OPENAI_API_KEY anywhere — the first model call will fail."));
  }
  parts.push(
    `${bold("effective model:")} ${effectiveModel(view, shared.selection) ? cyan(effectiveModel(view, shared.selection)!) : red("none — the model step sets one")}`,
  );
  return parts.join("\n\n");
}

export function summaryText(shared: SharedState): string {
  const tasks = selectedTasks(shared);
  const first = tasks[0]!;
  const view = resolveEnvView(first.path, process.env);
  const model = shared.selection.model;
  const modelPrefix = model ? `OPENROUTER_MODEL='${model}' ` : "";
  const commands = tasks.map((t) => `${modelPrefix}apo task run ${t.id}`);
  const taskLines =
    tasks.length === 1
      ? [
          `${bold("task")}   ${first.id}`,
          first.description ? `${dim("what")}    ${first.description}` : "",
        ]
      : [
          `${bold("tasks")}  ${tasks.length} selected`,
          ...tasks.map((t) => `  ${cyan(t.id)}  ${dim(checksHint(t))}`),
        ];
  return [
    ...taskLines,
    `${bold("model")}  ${model ? cyan(model) : dim(effectiveModel(view, shared.selection) ?? "from .env (nothing set!)")}`,
    tasks.length === 1 ? `${bold("judge")}  ${checksHint(first)}` : "",
    "",
    ...commands.map((c) => `  ${dim("$")} ${bold(c)}`),
  ].filter((line) => line !== "").join("\n");
}

export function shortPath(path: string): string {
  return path.replace(`${process.cwd()}/`, "").replace(process.env.HOME ?? "", "~");
}

export function sourceLabel(source: string | null): string {
  if (source === "process env") return "process env";
  return source !== null ? shortPath(source) : "set";
}

/** Non-interactive render used by `--preview`: the whole journey at a glance. */
export function renderWizardStatic(shared: SharedState): string {
  // The tree fully expanded with a sample partial folder check, to show the
  // checkbox states: [ ] unchecked, [~] some children, [x] all children.
  const demoChecked = new Set(["real-agent/engineering/api-testing", "real-agent/engineering/bug-triage"]);
  const treeLines: string[] = [];
  const subtreeKeys = (n: TreeNode<TaskCard>): string[] =>
    n.value !== undefined ? [n.key] : (n.children ?? []).flatMap(subtreeKeys);
  const box = (n: TreeNode<TaskCard>): string => {
    const keys = subtreeKeys(n);
    const c = keys.filter((k) => demoChecked.has(k)).length;
    return c === 0 ? " " : c === keys.length ? "x" : "~";
  };
  const walk = (nodes: TreeNode<TaskCard>[], depth: number) => {
    for (const n of nodes) {
      const indent = "  ".repeat(depth);
      const b = box(n);
      const checkbox = b === "x" ? green(`[${b}]`) : b === "~" ? yellow(`[${b}]`) : dim(`[${b}]`);
      if (n.children !== undefined) {
        treeLines.push(`    ${indent}${checkbox} ${cyan(`▾ ${n.name}`)}  ${dim(String(n.count ?? ""))}`);
        walk(n.children, depth + 1);
      } else {
        treeLines.push(`    ${indent}${checkbox} ${n.name}${n.hint ? `  ${dim(n.hint)}` : ""}`);
      }
    }
  };
  walk(shared.tree, 0);
  const modelLines = modelTree(shared.models, "OPENROUTER_MODEL (already set)").map((n) =>
    `    ${n.children ? cyan(`▸ ${n.name}`) : n.name}  ${dim(String(n.count ?? n.hint ?? ""))}`,
  );
  return [
    bold("Run an eval") + dim("   [→] open [←] close [space] check [enter] run"),
    ...treeLines,
    "",
    bold("Model") + dim("   [→] open · type to filter"),
    ...modelLines,
    "",
    bold("Ready to run"),
    summaryText(shared),
    readinessLine(shared),
    dim("[d] full details:"),
    envScreenText(shared),
  ].join("\n");
}
