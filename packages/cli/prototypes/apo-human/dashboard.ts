/**
 * PROTOTYPE ONLY — variant 3/3: a full-screen task browser (k9s/lazygit
 * shape). One stable frame, list left, detail right. Answers: is browsing
 * + inline detail worth a full-screen app, or overkill for eval running?
 */
import { bold, cyan, dim, green, red, yellow } from "../../src/lib/format.ts";
import { checksHint, effectiveModel, hasProviderKey, resolveEnvView, type SharedState } from "./data.ts";
import { bottomBar, waitKey } from "./ui.ts";
import { envScreenText, runWizard, task as selectedTask, type VariantResult } from "./wizard.ts";

const VIEWPORT = 12;

export async function runDashboard(shared: SharedState): Promise<VariantResult> {
  while (true) {
    shared.cursor = Math.min(shared.cursor, shared.tasks.length - 1);
    shared.selection.taskId = shared.tasks[shared.cursor]?.id;
    console.clear();
    console.log(frameText(shared));
    console.log(bottomBar(2) + dim("   [↑↓] select · [Enter] guided run · [e] env detail"));

    const key = await waitKey();
    if (key.name === "tab") return "switch";
    if (key.name === "q") return "quit";
    if (key.name === "up" || key.name === "k") shared.cursor = Math.max(0, shared.cursor - 1);
    if (key.name === "down" || key.name === "j") shared.cursor = Math.min(shared.tasks.length - 1, shared.cursor + 1);
    if (key.name === "return" || key.name === "enter") {
      const result = await runWizard(shared);
      if (result === "quit") return "quit";
    }
    if (key.name === "e") {
      console.clear();
      console.log(`${bold("environment")} ${dim(`— ${selectedTask(shared).id}`)}\n\n${envScreenText(shared)}`);
      console.log(dim("\n[any key] back"));
      await waitKey();
    }
  }
}

function frameText(shared: SharedState): string {
  const ids = shared.tasks.map((t) => t.id);
  const colWidth = Math.min(42, Math.max(...ids.map((id) => id.length), 10));
  const snippetWidth = 30;
  const leftWidth = 2 + colWidth + 1 + snippetWidth;

  const start = Math.max(0, Math.min(shared.cursor - Math.floor(VIEWPORT / 2), shared.tasks.length - VIEWPORT));
  const visible = shared.tasks.slice(start, start + VIEWPORT);

  const left = visible.map((t) => {
    const marker = t.id === shared.selection.taskId ? "\u276f " : "  ";
    const label = t.id === shared.selection.taskId ? bold(t.id.padEnd(colWidth)) : dim(t.id.padEnd(colWidth));
    const snippet = t.description ? ` ${truncate(t.description, snippetWidth)}` : "";
    return `${marker}${label}${dim(snippet.padEnd(1 + snippetWidth - snippet.length))}`;
  });

  const right = detailLines(shared);

  const lines: string[] = [
    bold("apo — task browser") + dim(`   ${shared.taskSource}`),
    "",
  ];
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    lines.push(`${(left[i] ?? "").padEnd(leftWidth)}│ ${right[i] ?? ""}`);
  }
  return lines.join("\n");
}

function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function detailLines(shared: SharedState): string[] {
  const t = selectedTask(shared);
  const view = resolveEnvView(t.path, process.env);
  const model = effectiveModel(view, shared.selection);
  const what = t.description
    ? wrap(t.description, 44).map((line) => dim(line))
    : [dim("no description in the task file")];
  return [
    bold(t.id),
    ...what,
    dim([t.category, checksHint(t)].filter(Boolean).join(" · ")),
    "",
    bold("environment"),
    `  model   ${model ? cyan(model) : red("not set")}`,
    `  key     ${hasProviderKey(view) ? green("provider key ✓") : yellow("no provider key ✗")}`,
    `  other   ${view.others.length > 0 ? dim(`${view.others.length} vars from .env (see [e])`) : dim("none")}`,
    "",
    dim(`selected model: ${shared.selection.model ?? "—"}`),
    "",
    dim("[e] full environment detail"),
  ];
}

/** Wrap text to a width the right pane can hold, honoring ANSI-free strings. */
function wrap(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width && line !== "") {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

export function renderDashboardStatic(shared: SharedState): string {
  shared.selection.taskId = shared.tasks[0]?.id;
  return frameText(shared);
}
