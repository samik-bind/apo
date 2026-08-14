import type { TraceObservation } from "./contexts";
import { formatCostMicro, formatDuration, formatTokenTotal } from "@/lib/format";

/** Aggregated duration / tokens / cost for a whole run (the TraceTree root row). */
export function getRunSummary(calls: TraceObservation[]) {
  const totalDuration = calls.reduce((sum, call) => sum + (call.latency_ms ?? 0), 0);
  const totalTokens = calls.reduce((sum, call) => sum + (call.total_tokens ?? 0), 0);
  const totalCost = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0);

  return {
    duration: totalDuration > 0 ? formatDuration(totalDuration) : null,
    tokens: totalTokens > 0 ? formatTokenTotal(totalTokens) : null,
    cost: totalCost > 0 ? formatCostMicro(totalCost) : null,
  };
}
