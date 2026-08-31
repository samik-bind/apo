/**
 * PROTOTYPE ONLY — variant 3/3: a full-screen task browser (k9s/lazygit
 * shape). One stable frame, list left, detail right. Answers: is browsing
 * + inline detail worth a full-screen app, or overkill for eval running?
 */
// color roles: cyan folders, default tasks, dim hints — same as the tree picker
import { bold, cyan, dim, green, red, visibleLength, yellow } from "../../src/lib/format.ts";
import { checksHint, effectiveModel, groupTasks, hasProviderKey, resolveEnvView, shortName, type SharedState, type TaskCard } from "./data.ts";
import { bottomBar, waitKey } from "./ui.ts";
import { envScreenText, runWizard, task as selectedTask, type VariantResult } from "./wizard.ts";

const VIEWPORT = 12;

export async function runDashboard(shared: SharedState): Promise<VariantResult> {
  // The cursor walks the group-flattened task order; headers are context.
  const flat = (): TaskCard[] => groupTasks(shared.tasks).flatMap((g) => g.tasks);
  while (true) {
    const tasks = flat();
    shared.cursor = Math.min(Math.max(shared.cursor, 0), tasks.length - 1);
    shared.selection.taskId = tasks[shared.cursor]?.id;
    console.clear();
    console.log(frameText(shared));
    console.log(bottomBar(2) + dim("   [↑↓] select · [Enter] guided run · [e] env detail"));

    const key = await waitKey();
    if (key.name === "tab") return "switch";
    if (key.name === "q") return "quit";
    if (key.name === "up" || key.name === "k") shared.cursor = Math.max(0, shared.cursor - 1);
    if (key.name === "down" || key.name === "j") shared.cursor = Math.min(tasks.length - 1, shared.cursor + 1);
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
  // Folder tree: dim group headers, bare task names under them. The cursor
  // indexes the flattened task order, so track positions while building rows.
  const ordered: { task?: TaskCard; folder?: string }[] = [];
  const taskPositions: number[] = [];
  groupTasks(shared.tasks).forEach((g) => {
    ordered.push({ folder: g.folder });
    g.tasks.forEach((t) => {
      taskPositions.push(ordered.length);
      ordered.push({ task: t });
    });
  });
  const cursorPos = taskPositions[Math.min(Math.max(shared.cursor, 0), taskPositions.length - 1)] ?? 0;

  const windowStart = Math.max(0, Math.min(cursorPos - Math.floor(VIEWPORT / 2), ordered.length - VIEWPORT));
  const window = ordered.slice(windowStart, windowStart + VIEWPORT);

  const left = window.map((r) => {
    if (r.folder !== undefined) return cyan(bold(r.folder));
    const selected = r.task!.id === shared.selection.taskId;
    return `${selected ? bold("\u276f ") : "  "}${selected ? bold(shortName(r.task!)) : shortName(r.task!)}`;
  });
  const colWidth = Math.min(42, Math.max(...shared.tasks.map((t) => shortName(t).length), 10)) + 6;

  const right = detailLines(shared);

  const lines: string[] = [
    bold("apo — task browser") + dim(`   ${shared.taskSource}`),
    "",
  ];
  const rowCount = Math.max(left.length, right.length);
  for (let i = 0; i < rowCount; i++) {
    const cell = left[i] ?? "";
    const pad = " ".repeat(Math.max(0, colWidth - visibleLength(cell)));
    lines.push(`${cell}${pad}│ ${right[i] ?? ""}`);
  }
  return lines.join("\n");
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
