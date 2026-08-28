# Hosted Alpha Agent-Adopter Rehearsal

Three isolated agent roles exercise the real hosted boundary. The question
this runbook answers: **can an agent without private repository context reach a
useful, inspectable Task Run using only the invitation, product UI, public
docs, and published packages?**

Everything below runs against the existing hosted installation
(`https://test-apo.online`). No second server, no synthetic users, no company
data.

## Roles and the one rule that holds it together

| Label | Who | Allowed |
|---|---|---|
| `[operator-agent]` | Agent using the installation admin account | Issue/revoke one rehearsal invitation and prepare bounded evidence |
| `[adopter-agent]` | Agent in a clean browser context and external workspace | **Only** the invitation link, product UI, public docs, public npm packages, and public example repo |
| `[reviewer-agent]` | Independent evidence-audit pass | Reject private shortcuts, verify claims, and record blockers |

The rule: during `[adopter-agent]` steps there is no SSH, no database, no monorepo,
no copied API keys, no admin credentials, no internal URLs. If the invitee is
stuck, the reviewer records the dependency as friction — that is a finding,
not a reason to smuggle in maintainer knowledge. File it; do not explain around
it.

This rehearsal does not consume maintainer time and does not claim to prove
human usability. Real invited users provide that evidence later.

## Prerequisites

- The hosted deployment is current and healthy (Section 2 preflight).
- A **clean browser context** that has never visited the installation — zero
  cookies, password-manager state, or history.
- A **workspace directory outside the Apo monorepo**, e.g. `~/adopter-rehearsal/`.
- A model-provider credential available **only in the invitee shell**
  (whatever the Task needs — the hosted server never holds provider keys).
- Node 22+ in the invitee shell (`node --version`).

## 1. Safety boundaries

- The company Project on the installation is read-only scenery: the invitee
  must be *denied* access to it, never granted it.
- The rehearsal creates exactly one invitee User, one invitation, and one
  private Project. Nothing else on the server changes.
- PASS **and** evaluated FAIL both count as a recorded outcome. An execution
  error does not — it means retry after diagnosing.

## 2. `[operator-agent]` Read-only public preflight

From any machine outside the deployment:

```bash
scripts/hosted-alpha-live-smoke.sh https://test-apo.online https://docs.test-apo.online
```

Expected:

```text
hosted alpha preflight: ok
  application entry: reachable
  invitation entry:  reachable
  CLI API entry:     reachable
  docs:              reachable
  readiness:         ready
```

If this fails, stop and fix the deployment first — the rehearsal tests the
product, not the outage.

## 3. `[operator-agent]` Issue the invitation

1. Sign in to `https://test-apo.online` with the installation admin account.
2. Open **Settings → Hosted access**.
3. Invite an isolated rehearsal email (for example,
   `agent-adopter@…`). Delivery is out-of-band: copy the **one-time
   invitation link** the UI offers.
4. Sign out. From here on you are not the admin.

## 4. `[reviewer-agent]` Start the evidence record

From the moment the invitation link is opened until the first recorded Run is
opened in the dashboard, record:

- every failed or repeated action;
- every time the adopter agent consulted something that was not the invitation,
  the UI, the public docs, or CLI output;
- anything the adopter agent supplied that the product could have pre-filled.

## 5. `[adopter-agent]` Accept the invitation

Requirements recap: clean browser context, no private knowledge of how Apo is
built.

1. Open the invitation link. You should see **Create your apo Project** with
   your email locked in.
2. Choose a name, a password, and a Project name; submit.
3. You land on your Project's task list showing **Get your first recorded
   run** — four steps with copyable commands.
4. Copy the exact login command shown (it already contains the origin and
   your Project id). Do not retype it.

## 6. `[adopter-agent]` First recorded Run from the external workspace

```bash
mkdir -p ~/adopter-rehearsal && cd ~/adopter-rehearsal
npm install -g @apo-ai/cli
apo login --backend https://test-apo.online --project <paste-from-panel>
```

Then follow **one** of the two paths the first-run panel offers:

- **Maintained example** (fastest): the panel's *Try the maintained example*
  link leads to the public example repository's `START-HERE.md`. Follow it as
  published.
- **Own repository**: the panel's *Use APO in my own agent repository* link
  leads to the hosted-alpha docs. Define one Task with the SDK, publish, run.

Publish and run:

```bash
apo task publish --dir <task-root>
apo task run <task-id> --dir <task-root>
```

The run command prints the exact Run identity — keep it. Open the dashboard's
**Runs** page and open that exact Run. A terminal PASS or FAIL completes this
scene; an execution error does not (diagnose, retry).

## 7. `[adopter-agent]` Understand a failure from evidence alone

Make one run fail honestly: change the Task implementation (not its tests or
fixtures) so an evaluation fails, run again, and in the run detail use
**Tests**, **Trace**, and **Deliverables** (or its explicit absence) to answer:
*what failed, and which implementation surface should change?*

Write the answer down before moving on. If you cannot answer it from product
evidence alone, that is a blocking finding.

## 8. Recovery scenes

Trigger each state and confirm the product's message is distinct and the next
safe action is clear — no SSH, no database, no maintainer knowledge:

| Scene | How to trigger | Expected |
|---|---|---|
| Invalid invitation | Open the used invitation link again, or edit one character of the token | Bounded "already used / no longer valid" page, no data leaked |
| Wrong password | `apo login` with a wrong password once | Clear invalid-credentials error; retry works |
| Missing provider key | Unset the provider credential in a fresh shell, run the Task | Execution error that names the missing credential, run recorded as error — never mislabeled PASS/FAIL |
| Pre-evaluation failure | Break the Task code so it errors before checks run | Error state with the run's own evidence; onboarding guidance stays visible |

## 9. `[adopter-agent]` Isolation scene

From the invitee session, attempt to reach the company Project: guess its URL
under `/project/<id>/…` or list `/v1/projects` with the invitee's CLI key.
Expected: not found / 403. The invitee's world contains exactly one Project.

## 10. `[adopter-agent]` Comparison scene

Requires two model views over the same Tasks (e.g. runs recorded from two
different models, including at least one Task where both pass). Select the
Tasks, compare the two explicit model views, then:

- every matched run appears on both sides with outputs/reasoning, duration,
  tokens, and available cost;
- no run is paired with itself (issue #140 must be resolved — if not, stop
  here and file it as the blocker it is);
- switch the time range to **All time**, reload, and confirm the selection
  persists.

## 11. `[reviewer-agent]` Audit and record the result

Append a dated entry under `## Log` in the rehearsal spec using exactly this shape —
no credentials, invitation URLs, cookies, API keys, private Task contents, or
company Project/run IDs:

```text
date:
deployment origin:
CLI version:
SDK version:
invite accepted: yes/no
first recorded Run: PASS/FAIL/error (opaque test Project Run ID optional)
trace opened: yes/no
deliverables opened: yes/no/not produced
company Project access denied: yes/no
comparison showed both sides: yes/no/not run
recovery scenes passed:
friction observed:
blocking defects filed:
decision: ready for first external invite / repeat rehearsal
```

Every friction point becomes either a filed issue (with the observed scene and
expected behavior) or an explicit decision to ignore it. Nothing is silently
absorbed into this runbook.

## 12. `[operator-agent]` Cleanup

- Revoke any unused invitations via **Settings → Hosted access**.
- The rehearsal User/Project: retain, clearly labeled (e.g. Project named
  "Agent-adopter rehearsal 2026-08-23"), or delete through supported product
  operations only. If supported deletion does not exist, retaining is the
  correct outcome — never edit the database to clean up.
- Company data is never touched by cleanup.
- Remove the external workspace directory from the invitee machine
  (`~/adopter-rehearsal/`), including any CLI credentials inside it.

## The deterministic layer

- `pnpm test:hosted-alpha-journey` — fixture-backed live-smoke contract plus
  the fresh-browser invitation journey against a dedicated production-shaped
  local stack (see the command's failure output for stack preparation).
- The local rehearsal stack from this session's verification (throwaway
  Compose project `apo183`-style: base + server profile + loopback port
  override, `APO_PUBLIC_URL=http://localhost:8080`, `INIT_USER_*` bootstrap,
  `DEV_SIGNIN_ENABLED=false`) is disposable — `docker compose -p <name> down
  -v` removes it entirely.
