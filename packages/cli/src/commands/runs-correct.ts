/**
 * `apo runs correct <run-id> <test-id> (--pass | --fail | --clear)` —
 * Manual test result corrections.
 *
 * Records a human decision about one recorded top-level Test: effective
 * PASS/FAIL, or clear back to the recorded result. The Check Report,
 * assertions, judge responses, and judgments stay untouched machine
 * evidence. Never opens a prompt or editor — safe for agents and CI.
 */

import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson, passFail } from "../lib/format.ts";
import { apiPost } from "../lib/api.ts";
import { resolveRunId } from "../lib/runs-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";

type CorrectedTestResult = {
  test_id: string;
  recorded_pass: boolean;
  effective_pass: boolean;
  correction: {
    id: string;
    action: "set_pass" | "set_fail" | "clear";
    pass_result: boolean;
    reason: string;
    corrected_by_user_id: string | null;
    corrected_by_label: string | null;
    corrected_via: "session" | "api_key" | "open_dev";
    created_at: string;
  } | null;
  run_status: "passed" | "failed";
  run_pass_result: boolean;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  corrected_tests: number;
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const json = flags.json === true;

  const [input, testId] = positional;
  if (!input || !testId) {
    console.error("Missing required arguments: <run-id> <test-id>");
    console.error(
      dim("Usage: apo runs correct <run-id> <test-id> (--pass | --fail | --clear) [--reason <text>]"),
    );
    return 2;
  }

  const wantsPass = flags.pass === true;
  const wantsFail = flags.fail === true;
  const wantsClear = flags.clear === true;
  const actionCount = [wantsPass, wantsFail, wantsClear].filter(Boolean).length;
  if (actionCount !== 1) {
    console.error("Provide exactly one of --pass, --fail, or --clear");
    return 2;
  }

  const reason = getFlagValue(flags, "reason");
  const action = wantsPass ? "set_pass" : wantsFail ? "set_fail" : "clear";
  if (action !== "clear" && !reason) {
    console.error(`--reason is required for --${wantsPass ? "pass" : "fail"} (3–1000 chars)`);
    return 2;
  }

  const taskFilter = getFlagValue(flags, "task");
  let runId: string;
  try {
    runId = await resolveRunId(config.backendUrl, input, config, taskFilter);
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  let result: CorrectedTestResult;
  try {
    result = await apiPost<CorrectedTestResult>(
      config.backendUrl,
      `/v1/agent-task-runs/${runId}/test-result-corrections`,
      {
        test_id: testId,
        action,
        ...(action !== "clear" && reason ? { reason } : {}),
      },
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (json) {
    console.log(formatJson(result));
    return 0;
  }

  printTransition(result);
  return 0;
}

function printTransition(result: CorrectedTestResult): void {
  const transition = `recorded ${passFail(result.recorded_pass)} → effective ${passFail(result.effective_pass)}`;
  console.log(`${bold(result.test_id)}: ${transition}`);
  const verdict = `${result.run_status.toUpperCase()}  ${result.passed_tests}/${result.total_tests} tests passing`;
  console.log(`Run: ${verdict}${result.corrected_tests > 0 ? dim(`  (${result.corrected_tests} corrected)`) : ""}`);
  if (result.correction) {
    const who = result.correction.corrected_by_label ?? result.correction.corrected_by_user_id ?? "unknown";
    console.log(dim(`by ${who} via ${result.correction.corrected_via}: ${result.correction.reason}`));
  } else {
    console.log(dim("restored to the recorded result"));
  }
  console.log(dim("recorded evidence preserved — Check Report, assertions, and judgments unchanged"));
}
