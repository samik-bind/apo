# Repair Trial: analytics-report

Implement the analytics-report behavior in `{{WORKSPACE_DIR}}/implementation/`.

You are driving a real coding-agent feedback loop through Apo. A fixed Golden
Task defines correct behavior. A deliberately incomplete starting
implementation currently fails it. Your job is to repair the implementation —
not weaken the task.

## Definition of done

- Run the real analytics-report agent through Apo.
- All four Tests in the fixed Golden Task pass:
  `used-report-workflow`, `report-contains-required-metrics`,
  `conclusions-are-supported`, `report-inputs-present`.
- Do not hardcode metrics from the fixture (840, 5%, 42%, 126000, ...). The
  report must come from running the agent against `metrics.json`, not from
  literals in implementation code.

## Allowed edits

- `{{WORKSPACE_DIR}}/implementation/**`

## Do not edit (protected — mutating these ends the trial)

- `{{WORKSPACE_DIR}}/adapter.ts`
- `{{WORKSPACE_DIR}}/tasks/**`
- `{{WORKSPACE_DIR}}/AGENT-PROMPT.md`
- the main example service outside this rehearsal workspace

## Verification loop

Repeat at most three times. Stop on PASS or after 3 Task Runs.

1. Run `pnpm video:rehearsal:verify` and confirm protected files are intact.
2. Run:
   ```
   apo task run analytics-report --dir {{WORKSPACE_TASK_ROOT}} --json
   ```
3. Capture the **exact Task Run id** printed by that command.
4. Inspect that exact run:
   ```
   apo runs show <exact-run-id> --json
   ```
   If a Trace is shown, capture its exact Trace id and use it for any
   `apo traces show <exact-trace-id>`.
5. Change **only** implementation code when the evidence points to an
   implementation defect.
6. Stop on PASS, or after 3 Task Runs, or if Apo reports an execution /
   infrastructure error that implementation changes cannot resolve.

## Rules

- Never use bare `apo runs show`, "latest", or a Run id copied from an earlier
  trial. Every diagnosis uses the exact Run id your own invocation returned.
- Never weaken the Golden Task (the eval, fixtures, adapter, or this prompt) to
  obtain PASS. If Apo reports an execution/infrastructure error rather than a
  failed verdict, report the error and stop — do not disguise it as a PASS.
- Do not hardcode fixture values. The starting defect is orchestration
  behavior, not a missing canned answer.
