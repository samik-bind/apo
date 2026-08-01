import type {
  AgentTaskBatchRunConfigurationSummary,
  AgentTaskRunConfiguration,
} from "./agent-task-api";

/**
 * Drop the provider/org prefix from a model id for compact display.
 * `openai/gpt-5.1` → `gpt-5.1`, `anthropic/claude-opus-4.1` → `claude-opus-4.1`.
 * The provider isn't interesting at a glance and long qualified names overflow
 * the Execution column. The full name stays available via the tooltip/title and
 * remains the value stored, filtered, and compared on.
 */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * render a Task Run's adapter-reported configuration as a compact
 * `model · effort` string. The model is shown without its provider prefix
 * (see {@link shortModel}); absent effort renders as `—` (em dash); a run that
 * reported no configuration renders as a lone `—`. Monochrome data — never a
 * colored badge (see docs/design.md).
 */
export function formatRunExecution(
  config: AgentTaskRunConfiguration | null,
): string {
  if (!config) return "\u2014";
  const effort = config.effort && config.effort !== "" ? config.effort : "\u2014";
  return `${shortModel(config.model)} · ${effort}`;
}

/**
 * The full, provider-qualified `model · effort` form — used for tooltips so the
 * exact identity is one hover away even though the visible cell is shortened.
 */
export function formatRunExecutionFull(
  config: AgentTaskRunConfiguration | null,
): string {
  if (!config) return "\u2014";
  const effort = config.effort && config.effort !== "" ? config.effort : "\u2014";
  return `${config.model} · ${effort}`;
}

/**
 * render a Batch Run's derived configuration summary.
 *
 * - uniform → the single `model · effort` pair;
 * - mixed   → `Mixed · N configs`;
 * - partial → `Partial · X/Y reported`;
 * - unknown → `—`.
 *
 * Never substitutes the most common child model as though the batch were
 * uniform — a mixed/partial batch is labeled honestly.
 */
export function formatBatchExecution(
  summary: AgentTaskBatchRunConfigurationSummary,
): string {
  switch (summary.state) {
    case "uniform": {
      const pair = summary.configurations[0];
      return pair ? formatRunConfigurationPair(pair) : "\u2014";
    }
    case "mixed":
      return `Mixed · ${summary.configurations.length} config${summary.configurations.length === 1 ? "" : "s"}`;
    case "partial":
      return `Partial · ${summary.reported_task_runs}/${summary.total_task_runs} reported`;
    case "unknown":
    default:
      return "\u2014";
  }
}

function formatRunConfigurationPair(
  pair: AgentTaskRunConfiguration,
): string {
  const effort = pair.effort && pair.effort !== "" ? pair.effort : "\u2014";
  return `${shortModel(pair.model)} · ${effort}`;
}

