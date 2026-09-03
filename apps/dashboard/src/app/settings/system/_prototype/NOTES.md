# Prototype — System settings page IA

**Question:** the System page (`/settings/system`) is a vertical dump of four
unrelated cards. What should its information architecture be, given that ~90%
of it is read-only, env-derived instance state and the rest is dangerous
operator actions?

**Plan:** four switchable renderings on the existing route via `?variant=`
(default, no param = current rendering, unchanged):

| Key | Variant | Hypothesis |
|---|---|---|
| `current` | Current stacked cards | Baseline for comparison |
| `a` | Status hero + tabs | It's a *status page* first; config/data/danger are detail views behind tabs |
| `b` | Two-column console | It's an *instance inspector* — health and config side by side, zero scroll to scan |
| `c` | Config document | Nothing is editable, so present it honestly as an "effective config" report (`kubectl describe` style) |

Every variant must carry **all** the content (10 config fields with env-var
sources, readiness checks, task runtime, DB table counts, 3 destructive ops in
escalation order) so the comparison is fair.

**Prototype constraints:** destructive actions are stubbed (confirmations are
fully interactive, the final call fires a toast). DB stats and project list use
real read-only fetches.

## Handover

Verified 2026-09-03 on the shared dev server (whichever `next dev` holds the
working copy — currently port 3200, backend = docker stack on 8000). Log in as
`admin@test.com`, then flip with ◀ ▶ or ← → keys:

- `/settings/system?variant=current` — today's page (baseline)
- `/settings/system?variant=a` — status hero + tabs
- `/settings/system?variant=b` — two-column console
- `/settings/system?variant=c` — config document

Screenshots from the verification run sit in `shots/` (delete with the rest).
Re-shoot: `PROTO_SESSION_TOKEN=<jwt> node …/_prototype/screenshot.mjs http://localhost:<port>`.

Destructive buttons in variants are stubbed — confirmations are real, the
final call only fires a "(prototype) stubbed" toast.

**Verdict:** _(pending — which variant won, and what to steal from the others)_

## Known issues in the current page the variants fix

- Duplicated header: page says "System", nested `SystemSection` renders a
  second "Admin" h1 + warning banner.
- `ProjectResetSection` uses `rounded-lg` (design system: square only) and raw
  `text-amber-500` (token violation).
- Mixed confirmation idioms: JS `confirm()` for DB ops vs inline for project
  reset.
- Interesting signal (failing checks) sits below a wall of static config rows.

## Latent bug noticed while inventorying (not fixed by the prototype)

The dashboard calls `/backend-proxy/v1/admin/*` with `admin_key` as a URL
query param, but `backend/apo/routes/admin.py` reads the `x-admin-key`
**header** — nothing translates between them, so DB stats / reset / nuke from
the dashboard likely 401 against a real admin key. Whatever variant wins, the
real rebuild must settle this (proxy the session's admin role through, or send
the header).
