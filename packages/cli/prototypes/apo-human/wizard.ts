/**
 * PROTOTYPE ONLY — variant 1/3: a guided "run an eval" wizard. Four steps,
 * every screen re-rendered whole, every choice remembered across variant
 * switches. Answers: does step-by-step guidance kill the memorization tax?
 */
import { bold, cyan, dim, formatTable, green, red, yellow } from "../../src/lib/format.ts";
import { checksHint, effectiveModel, hasProviderKey, resolveEnvView, selectedTasks, type SharedState, type TaskCard } from "./data.ts";
import { askText, bottomBar, pick, pickTree, waitKey, type PickResult, type TreeNode } from "./ui.ts";

export type VariantResult = "switch" | "quit";

const CUSTOM = "custom";
const DEFAULT = "default";
type ModelChoice = { kind: "catalog"; id: string } | { kind: typeof CUSTOM } | { kind: typeof DEFAULT };

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
        bold("Run an eval — step 1/4: pick task(s)") +
          dim(`   (${shared.taskSource})`) +
          dim(`   [→] open [←] close [space] check${checkedCount > 0 ? ` (${checkedCount} checked)` : ""} [enter] run`),
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
      const result = await pick(
        bold("step 2/4: model") + dim(`   currently resolves to: ${current ?? "nothing — no model set"}`),
        [
          ...shared.models.map((m) => ({
            label: m.display,
            sub: `$${m.input} in / $${m.output} out per 1M tokens · ${m.id}`,
            value: { kind: "catalog", id: m.id } as ModelChoice,
          })),
          { label: "✎ type a model id…", sub: "anything your provider accepts", value: { kind: CUSTOM } as ModelChoice },
          { label: "keep what .env already selects", sub: "don't touch the model", value: { kind: DEFAULT } as ModelChoice },
        ],
      );
      const next = applyPick<ModelChoice>(result);
      if (next === "switch" || next === "quit") return next;
      if (next === "back") { step = 1; continue; }
      if (next.kind === CUSTOM) {
        shared.selection.model = await askText("model id", shared.models[0]?.id ?? "");
      } else if (next.kind === "catalog") {
        shared.selection.model = next.id;
      } else {
        delete shared.selection.model;
      }
      step = 3;
      continue;
    }

    if (step === 2) {
      console.clear();
      console.log(stepScreen(shared, 3));
      console.log(bottomBar(0) + dim("   [any key] continue · [b] back"));
      const key = await waitKey();
      if (key.name === "tab") return "switch";
      if (key.name === "q") return "quit";
      step = key.name === "b" || key.name === "escape" ? 1 : 3;
      continue;
    }

    console.clear();
    console.log(stepScreen(shared, 4));
    console.log(bottomBar(0) + dim("   [Enter] start over · [b] back"));
    const key = await waitKey();
    if (key.name === "tab") return "switch";
    if (key.name === "q") return "quit";
    step = key.name === "b" || key.name === "escape" ? 2 : 0;
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

function stepScreen(shared: SharedState, step: 3 | 4): string {
  return step === 3
    ? `${bold("Run an eval — step 3/4: environment check")}\n\n${envScreenText(shared)}`
    : `${bold("Run an eval — step 4/4: ready")}\n\n${summaryText(shared)}`;
}

/** The env screen — also reused by the menu and dashboard variants. */
export function envScreenText(shared: SharedState): string {
  const view = resolveEnvView(task(shared).path, process.env);
  const chain = view.files
    .map((f) => (f.exists ? green(`✓ ${shortPath(f.path)}`) : dim(`· ${shortPath(f.path)}`)))
    .join(dim("  →  "));
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
    `${bold("effective model:")} ${effectiveModel(view, shared.selection) ? cyan(effectiveModel(view, shared.selection)!) : red("none — step 2 sets one")}`,
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
    "",
    dim(tasks.length > 1
      ? "PROTOTYPE — would run these in sequence (or as one batch)."
      : "PROTOTYPE — would exec this now. The judge reads the same model var;"),
    dim(tasks.length > 1
      ? "Each run records to your project like any `task run`."
      : "the run records to your project like any `task run`."),
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
  const modelLines = shared.models.slice(0, 5).flatMap((m, i) => [
    `  ${i === 0 ? "\u276f" : " "} ${i === 0 ? m.display : dim(m.display)}`,
    `      ${dim(`$${m.input} in / $${m.output} out per 1M tokens · ${m.id}`)}`,
  ]);
  return [
    bold("Run an eval — step 1/4: pick task(s)") + dim(`   (${shared.taskSource})   [→] open [←] close [space] check [enter] run`),
    ...treeLines,
    "",
    bold("step 2/4: model"),
    ...modelLines,
    "",
    bold("step 3/4: environment check"),
    envScreenText(shared),
    "",
    bold("step 4/4: ready"),
    summaryText(shared),
  ].join("\n");
}
