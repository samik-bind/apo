# PROTOTYPE — apo for humans

This throwaway prototype asks one question:

> The apo CLI is shaped for agents (strict flags, `--json`, no prompts).
> Which structural shape should a **human-facing** interactive experience
> take — a guided wizard, a hub menu, or a full-screen dashboard — and does
> that flow remove the memorization tax (model names, which env vars matter)
> that `apo task run` has today?

Drive it:

```bash
pnpm prototype:apo-human                # interactive (needs a real terminal)
pnpm prototype:apo-human -- --preview   # static frame of every variant
```

## The three variants (Tab switches, selections survive)

1. **wizard** — `Run an eval` in four guided steps: pick task → pick model
   (from the pricing catalog, with $/1M shown) → environment preflight →
   the exact `apo task run` command it would exec.
2. **menu** — a hub: run / environment status / an env-var cheatsheet
   ("the whole list of vars apo reads — stop memorizing").
3. **dashboard** — k9s-style browser: task list left, detail + env state
   right, single stable frame.

## What's real

- Tasks come from your actual task root (`resolveConfig` + `discoverTaskMeta`,
  same as `apo task list`); models come from `backend/apo/data/default-model-prices.json`
  (ids synthesized from the pricing patterns — a real build needs a
  runnable-models source; none exists today); env state mirrors
  `task-run.ts`'s `.env` chain (first-wins, process.env wins).
- Falls back to clearly-marked SAMPLE data when the task root or catalog
  is missing.
- **Values of env vars are never read or shown** — names, set/missing, and
  source file only.

## Delete when done

Nothing here runs a real eval or mutates anything. Once the shape decision
is captured in NOTES.md (and folded into a real command), delete this
directory — the only liftable piece is `data.ts`'s read-only env resolver.
