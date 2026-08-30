/**
 * PROTOTYPE ONLY — entry point. Three structurally different shells over
 * the same real data (tasks from your task root, models from the pricing
 * catalog, env from the actual .env chain). Tab switches between them;
 * your selections survive the switch.
 *
 *   pnpm prototype:apo-human             interactive
 *   pnpm prototype:apo-human -- --preview   one static frame of each variant
 */
import { bold, dim } from "../../src/lib/format.ts";
import { loadShared } from "./data.ts";
import { initInput, shutdownInput, VARIANT_NAMES } from "./ui.ts";
import { renderWizardStatic, runWizard, type VariantResult } from "./wizard.ts";
import { renderMenuStatic, runMenu } from "./menu.ts";
import { renderDashboardStatic, runDashboard } from "./dashboard.ts";

const QUESTION = "Which shape should apo's human-facing experience take — wizard, hub, or dashboard?";

async function main(): Promise<number> {
  const shared = await loadShared();

  if (process.argv.includes("--preview") || !process.stdin.isTTY) {
    printPreview(shared);
    return 0;
  }

  initInput();
  let index = 0;
  try {
    while (true) {
      const run = [runWizard, runMenu, runDashboard][index]!;
      const result: VariantResult = await run(shared);
      if (result === "quit") break;
      index = (index + 1) % VARIANT_NAMES.length;
    }
  } finally {
    shutdownInput();
  }
  console.clear();
  return 0;
}

function printPreview(shared: Awaited<ReturnType<typeof loadShared>>): void {
  const banner = [
    bold("PROTOTYPE — apo for humans"),
    dim(QUESTION),
    dim(`tasks: ${shared.taskSource}`),
    dim(`models: ${shared.modelSource}`),
  ].join("\n");
  console.log(banner);
  console.log(dim("\n════ variant 1/3 — wizard: guided run ════\n"));
  console.log(renderWizardStatic(shared));
  console.log(dim("\n════ variant 2/3 — menu: hub ════\n"));
  console.log(renderMenuStatic(shared));
  console.log(dim("\n════ variant 3/3 — dashboard: browser ════\n"));
  console.log(renderDashboardStatic(shared));
  console.log(
    dim("\nThis is the non-interactive preview. Run `pnpm prototype:apo-human` in a real terminal to drive it (Tab switches variants).\n"),
  );
}

main().then((code) => process.exit(code));
