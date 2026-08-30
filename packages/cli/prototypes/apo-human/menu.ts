/**
 * PROTOTYPE ONLY — variant 2/3: a hub menu. One stable screen that answers
 * "what can I even do here?" — answers: is a hub the right home for humans,
 * or does it just add a step before the wizard?
 */
import { bold, dim, formatTable } from "../../src/lib/format.ts";
import { resolveEnvView, type SharedState } from "./data.ts";
import { bottomBar, waitKey } from "./ui.ts";
import { envScreenText, runWizard, sourceLabel, task, type VariantResult } from "./wizard.ts";

export async function runMenu(shared: SharedState): Promise<VariantResult> {
  while (true) {
    console.clear();
    console.log(hubText(shared));
    console.log(bottomBar(1));
    const key = await waitKey();
    if (key.name === "tab") return "switch";
    if (key.name === "q") return "quit";
    if (key.name === "r") {
      const result = await runWizard(shared);
      if (result !== "quit") continue;
      return "quit";
    }
    if (key.name === "e") {
      console.clear();
      console.log(`${bold("Environment & models")}\n\n${envScreenText(shared)}\n`);
      console.log(modelsTableText(shared));
      console.log(dim("\n[any key] back"));
      await waitKey();
    }
    if (key.name === "h") {
      console.clear();
      console.log(cheatsheetText(shared));
      console.log(dim("\n[any key] back"));
      await waitKey();
    }
  }
}

function hubText(shared: SharedState): string {
  return [
    bold("apo — home"),
    dim(`${shared.taskSource} · ${shared.modelSource}`),
    "",
    `${bold("[r]")} run an eval       ${dim("guided: task → model → env → command")}`,
    `${bold("[e]")} environment        ${dim("what your .env chain resolves right now")}`,
    `${bold("[h]")} cheatsheet         ${dim("the env vars apo reads — stop memorizing")}`,
    "",
    dim(`selected: ${shared.selection.taskId ?? "—"}`),
  ].join("\n");
}

function modelsTableText(shared: SharedState): string {
  const rows = shared.models.map((m) => [
    m.display,
    dim(m.provider),
    `$${m.input}`,
    `$${m.output}`,
    dim(m.id),
  ]);
  return formatTable(["model (from pricing catalog)", "provider", "in/1M", "out/1M", "id"], rows);
}

function cheatsheetText(shared: SharedState): string {
  const view = resolveEnvView(task(shared).path, process.env);
  const rows = view.known.map((v) => [
    v.name,
    dim(v.meaning),
    v.set ? `set · ${sourceLabel(v.source)}` : dim("not set"),
  ]);
  return [
    bold("The env vars apo reads"),
    dim("This is the whole list — if it's not here, apo doesn't need it."),
    "",
    formatTable(["var", "what it does", "right now"], rows),
  ].join("\n");
}

export function renderMenuStatic(shared: SharedState): string {
  return [
    hubText(shared),
    "",
    `${bold("[e] environment")} →`,
    envScreenText(shared),
    "",
    `${bold("[h] cheatsheet")} →`,
    cheatsheetText(shared),
    "",
    `${bold("models")} ${dim(`(${shared.modelSource})`)}`,
    modelsTableText(shared),
  ].join("\n");
}
