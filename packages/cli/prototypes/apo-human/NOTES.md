# NOTES — verdicts from driving the prototype

Decisions captured 2026-09-01 after live iteration rounds; the prototype
gets deleted once the real command absorbs them.

- [x] **Command: `apo run`** — a separate human-facing command. `apo task
      run` stays strictly flag/exit-code driven for agents and CI; `apo run`
      is the interactive terminal flow. No interactive fallback inside
      `task run`.
- [x] **Shape: the wizard flow won** — three screens, one question each:
      task tree → model picker → run manifest. The hub-menu and dashboard
      variants were comparison scaffolding; the tree picker is the core
      widget both trees share (multi-select checkboxes for tasks,
      single-select + type-to-filter for models).
- [x] **Density rules that survived every round:** navigate don't
      truncate (folders as a real tree); one fact per line; hints on one
      aligned rail; color = state (cyan folders, green ✓, yellow partial,
      dim secondary); stated-once conventions; data appears only where
      consumed (model id only in the command); Enter always advances.
- [x] **Env check: verdict-first.** One plain go/no-go line on the final
      screen ("✓ ready — model and API key found"); the full audit
      (.env chain, var table) is behind [d], diagnose-on-demand.
- [ ] **Enter executes for real** in `apo run` — via the existing
      caller-executor machinery; multi-check becomes a batch (backend
      already supports multi-task batch runs). Deliberately dry in the
      prototype: real runs cost money and record to the project.
- [ ] Open: last-run verdict per task in the tree (needs backend query —
      the single most decision-relevant missing fact).
- [ ] Open: type-to-filter on the task tree too, once task count grows.
- [x] **Absorb:** interaction design + `data.ts` logic (task discovery,
      env resolver, model list from pricing catalog) carry into `apo run`;
      rendering gets rebuilt on a TUI library (Ink — same language as the
      CLI). `task-meta.ts` grows description/check-count extraction so
      `task list` benefits. Then this directory is deleted.
