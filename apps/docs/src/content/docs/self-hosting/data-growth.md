---
title: Data Growth and Retention
description: "What apo accumulates as you use it, how the two retention tiers work, and the settings that keep a deployment bounded."
---

import TerminalOutput from '../../../components/demos/TerminalOutput.astro';

Every task run leaves a verdict, and behind it the evidence that explains the verdict: a trace (tool calls, model I/O), a check report, deliverables, attempt diagnostics, and the raw OTLP payloads the trace was built from. Left alone, all of it grows forever. This page explains what accumulates, what apo cleans up automatically, and which knobs bound a deployment without losing the history that matters.

## Two tiers: verdicts and evidence

apo's long-lived value is the **verdict history** — pass/fail per run, check counts, costs, corrections. It is tiny (a few hundred bytes per run) and is **never deleted automatically**; the regression timeline over months is the point.

The **evidence** behind those verdicts is most of the bytes and has decaying debugging value: a trace from six weeks ago rarely gets opened. Evidence can expire on a window while every verdict stays:

| Tier | Contents | Deleted automatically? |
|---|---|---|
| Verdicts | Run/batch rows, status, pass/fail, check counts, costs, corrections, judgment verdicts | Never |
| Evidence | Transcripts, traces (calls, metrics, spans), check-report documents, rejudge check evidence, deliverables (rows and stored objects), attempt stdout/stderr | After `APO_EVIDENCE_RETENTION_DAYS` |
| Replay inbox | Raw OTLP ingest payloads (up to 10 MiB per request) | After `APO_INGEST_RETENTION_DAYS` (default 7 days) |

After evidence expires, a run still shows its verdict everywhere — lists, stats, comparisons, the run detail header — but its checks read empty, the transcript and trace links are gone, and deliverables no longer resolve. **Bookmarking a trace keeps every byte of that run forever**: bookmarks are the escape hatch for runs you know you'll revisit.

:::caution[Evidence expiry is irreversible]
There is no undo. Export what you care about first — [`apo runs export`](/cli/runs-export/) writes a run's complete bundle (verdict, checks, judgment evidence, deliverables, trace) to one file — or bookmark the trace.
:::

## The daily maintenance pass

A maintenance pass runs at startup and then every 24 hours, in this order:

1. **Always**: blank past-window ingest payloads (the audit row with accepted/rejected counts stays); fail artifact uploads abandoned past their TTL and remove their staging bytes; delete expired verification/reset/enrollment tokens.
2. **If `APO_EVIDENCE_RETENTION_DAYS` is set**: expire the evidence tier of runs whose batch is older than the window (bookmarked runs skipped).
3. **If `APO_RETENTION_DAYS` is set**: delete old traces and batches entirely — runs, spans, checks, judgments, deliverable objects, revision bundles — keeping bookmarked traces, then `VACUUM` to hand file space back to the disk.

Nothing is deleted silently by default: both retention windows default to keep-forever, and only the replay-inbox trim (7 days) is on out of the box.

## What grows, roughly

| Data | Grows with | Typical weight |
|---|---|---|
| `otlp_ingest_batches.payload` | every OTLP request | up to 10 MiB each — the biggest single column; trimmed after 7 days by default |
| `otlp_spans` | every trace span | KBs per span with raw payloads; expires with evidence |
| `logged_calls` input/output | every model/tool call | KBs each; expires with evidence |
| `agent_task_runs.transcript_json` | every finalized run | KBs–MBs; expires with evidence |
| Check reports, judgment evidence | every run / rejudge | KBs each; expire with evidence |
| Deliverable artifacts | every run with file outputs | bounded per run (100 MiB/item, 500 MiB/run); deleted with evidence |
| Verdict rows | every run/batch | ~hundreds of bytes — never expires |
| Task definition revisions | every task-source edit | full `*.eval.ts` text per revision (kept: shared, content-addressed) |

## Per-project overrides

The deployment default is a blunt instrument — a scratch project and a
regression project rarely want the same window. **Settings → Retention**
(project admins) sets a per-project evidence window with three states:

- **Inherit deployment default** — whatever `APO_EVIDENCE_RETENTION_DAYS` says.
- **Keep evidence forever** — `0`, which *overrides* a shorter default for a precious project.
- **Expire after N days** — a per-project window (1–3650).

The setting is re-read on every maintenance pass, so a change applies the
next day. `GET /v1/projects/{id}` reports both the override
(`evidence_retention_days`) and the effective window
(`effective_evidence_retention_days`). Full deletion
(`APO_RETENTION_DAYS`) stays deployment-wide by design — it removes
verdicts, which is an operator decision rather than a per-project one.

## Choosing settings

- **Single box, regular use, occasionally debug old failures**: leave everything at defaults, or set `APO_EVIDENCE_RETENTION_DAYS=90`. Verdict history stays complete; the disk holds ~90 days of evidence.
- **Long-running regression rig**: `APO_EVIDENCE_RETENTION_DAYS=30` plus `APO_RETENTION_DAYS=365` — evidence for a month, whole runs for a year, verdicts forever.
- **Compliance-driven deletion**: `APO_RETENTION_DAYS` alone is the blunt instrument — everything about a run goes when the window passes.

The admin endpoint `GET /admin/retention` reports the effective policy, the DB file size, and per-table bytes (largest first) so you can see which knob a given deployment actually needs:

<TerminalOutput
  lines={[
    { text: '"evidence_retention_days": 90,', tone: "dim" },
    { text: '"ingest_payload_retention_days": 7,', tone: "dim" },
    { text: '"table_sizes": { "otlp_spans": 4831838208, "otlp_ingest_batches": 2147483648, ... },', tone: "dim" },
  ]}
/>

## See also

- [Configuration reference](/reference/configuration/) — every knob with its default.
- `apo runs delete` / `apo batch delete` — manual, irreversible cleanup of garbage runs.
- Bookmarking traces in the dashboard — the per-run "keep forever".
