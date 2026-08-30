/**
 * PROTOTYPE ONLY — variant 1/3: a guided "run an eval" wizard. Four steps,
 * every screen re-rendered whole, every choice remembered across variant
 * switches. Answers: does step-by-step guidance kill the memorization tax?
 */
import { bold, cyan, dim, formatTable, green, red, yellow } from "../../src/lib/format.ts";
import { checksHint, effectiveModel, hasProviderKey, resolveEnvView, type SharedState } from "./data.ts";
import { askText, bottomBar, pick, waitKey, type PickResult } from "./ui.ts";

export type VariantResult = "switch" | "quit";

const CUSTOM = "custom";
const DEFAULT = "default";
type ModelChoice = { kind: "catalog"; id: string } | { kind: typeof CUSTOM } | { kind: typeof DEFAULT };

export async function runWizard(shared: SharedState): Promise<VariantResult> {
  let step = 0;
  while (true) {
    if (step === 0) {
      const result = await pick(
        bold("Run an eval — step 1/4: pick a task") + dim(`   (${shared.taskSource})`),
        shared.tasks.map((t) => ({
          label: t.id,
          hint: checksHint(t),
          sub: t.description ?? undefined,
          value: t.id,
        })),
      );
      const next = applyPick(result);
      if (next === "switch" || next === "quit") return next;
      if (next !== "back") {
        shared.selection.taskId = next;
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
      if (next === "back") { step = 0; continue; }
      if (next.kind === CUSTOM) {
        shared.selection.model = await askText("model id", shared.models[0]?.id ?? "");
      } else if (next.kind === "catalog") {
        shared.selection.model = next.id;
      } else {
        delete shared.selection.model;
      }
      step = 2;
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
  const t = task(shared);
  const view = resolveEnvView(t.path, process.env);
  const model = shared.selection.model;
  const command = model ? `OPENROUTER_MODEL='${model}' apo task run ${t.id}` : `apo task run ${t.id}`;
  return [
    `${bold("task")}   ${t.id}`,
    t.description ? `${dim("what")}    ${t.description}` : "",
    `${bold("model")}  ${model ? cyan(model) : dim(effectiveModel(view, shared.selection) ?? "from .env (nothing set!)")}`,
    `${bold("judge")}  ${checksHint(t)}`,
    "",
    `  ${dim("$")} ${bold(command)}`,
    "",
    dim("PROTOTYPE — would exec this now. The judge reads the same model var;"),
    dim("the run records to your project like any `task run`."),
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
  const taskLines = shared.tasks.slice(0, 6).flatMap((t, i) => [
    `  ${i === 0 ? "\u276f" : " "} ${i === 0 ? t.id : dim(t.id)}  ${i === 0 ? checksHint(t) : dim(checksHint(t))}`,
    t.description ? `      ${dim(t.description)}` : "",
  ].filter((line) => line !== ""));
  const modelLines = shared.models.slice(0, 5).flatMap((m, i) => [
    `  ${i === 0 ? "\u276f" : " "} ${i === 0 ? m.display : dim(m.display)}`,
    `      ${dim(`$${m.input} in / $${m.output} out per 1M tokens · ${m.id}`)}`,
  ]);
  return [
    bold("Run an eval — step 1/4: pick a task") + dim(`   (${shared.taskSource})`),
    ...taskLines,
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
