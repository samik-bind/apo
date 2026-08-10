# Agent Repair-Loop Video Rehearsal

A repeatable **Video Rehearsal Scenario** for the first Apo product demo: a
coding agent receives a feature task, runs the real agent through Apo, reads a
failed verdict and its evidence, repairs implementation code, and reruns the
same Golden Task to PASS.

This is **rehearsal material, not the video**. It does not record, edit,
publish, or embed anything. The maintainer uses it for one or more Repair
Trials, decides whether the loop is clear and repeatable, and records only
after that manual gate succeeds.

## What's here

| Path | Role |
|---|---|
| `template/` | The tracked scenario: adapter, intentionally-broken implementation, Golden Task, fixtures, and the coding-agent prompt. Never edited by hand during a trial. |
| `scripts/prepare.mjs` | Prepare or reset the disposable `work/` workspace. |
| `scripts/verify-workspace.mjs` | Local-only integrity + identity checks (no provider). |
| `tests/rehearsal.test.ts` | Provider-free contract tests (`pnpm test:video-rehearsal`). |
| `work/` | Generated and gitignored. All agent edits and live Run artifacts happen here. |

The Golden Task is intentionally separate from the canonical `data-extraction`
newcomer example. The starting implementation is deliberately incomplete; this
directory is never imported by the application or the public canonical Task
tree.

## Prerequisites

- An authenticated current Apo CLI and selected Project.
- A reachable Apo Control Plane.
- `OPENROUTER_API_KEY` for both the real agent and the judge.
- Explicit `OPENROUTER_MODEL` and `AGENT_TASK_JUDGE_MODEL` so trials use the same
  models.
- A maintainer-selected maximum acceptable provider cost.
- No other process editing the scenario-owned `work/` directory.

## Run a Repair Trial

```bash
# 1. Prepare or reset a disposable trial.
pnpm video:rehearsal:prepare

# 2. Confirm the Golden Task and start state are intact.
pnpm video:rehearsal:verify

# 3. Publish the fixed Task definition if the selected Apo Project needs it.
apo task publish --dir <printed-work-task-root>

# 4. Give the generated work/AGENT-PROMPT.md to the coding agent.

# 5. After the agent stops, verify protected files again.
pnpm video:rehearsal:verify
```

### Reset for a retake

`pnpm video:rehearsal:prepare` is both prepare and reset. When `work/` exists it
replaces it **only** if the ownership marker (`.apo-video-rehearsal.json`) is
present, names scenario `agent-repair-loop-v1`, and points at this exact `work/`
directory. Otherwise it refuses and touches nothing. Reset permanently discards
only the generated `work/` directory.

## The intentional defect

The starting implementation calls the real `handleChat()` with `maxSteps: 2`.
That allows `list_files` and `read_file` but stops the run before the required
`compute` step. The `used-report-workflow` Test therefore fails on every fresh
start — the visible gap the coding agent must close. The intended repair is
general orchestration behavior (a sufficient step budget and a clear calculation
policy), **not** a hardcoded report.

## Video-ready gate (manual)

This scenario is video-ready only when, over at least three fresh Repair Trials
with the same models and settings:

- every fresh start produces a failed `used-report-workflow` check (not an
  execution error);
- at least two of three trials reach all four PASS within three Task Runs
  without protected edits or hardcoded fixture values;
- the failure output / Trace makes the missing calculation step clear on screen;
- at least one successful trial visibly uses Deliverables or Trace evidence;
- a successful trial edits into 60–90 seconds without hiding a manual rescue.

This gate spends provider money and observes a nondeterministic agent, so it is
not part of CI. See `specs/175-agent-repair-loop-video-rehearsal.md` for the
full gate.
