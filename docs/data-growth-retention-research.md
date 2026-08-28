# Data growth & retention research: what accumulates in apo, and how comparable tools bound it

> Research asset surveyed 2026-08-28. Sources: the apo backend code (file:line cited), the local Langfuse checkout at `../langfuse` (code-verified), and official documentation for Langfuse, LangSmith, Phoenix, Braintrust, and Datadog. This file records findings and a recommendation sketch — design decisions belong to the spec that comes out of it.

## The question

Every task run apo records leaves behind a batch row, a run row, a check report, a transcript, a full OTLP trace in two forms (projection + raw spans), the raw OTLP ingest payloads, deliverables, and attempt diagnostics. Today essentially nothing is cleaned up automatically: the one retention mechanism (`APO_RETENTION_DAYS`) defaults to **off**, and even when switched on it misses the two biggest byte holders. We surveyed what actually accumulates, what the existing mechanisms cover, and how comparable products (Langfuse in depth, plus LangSmith / Phoenix / Braintrust / Datadog) keep themselves bounded.

## Part 1 — apo today

### Current footprint (main docker stack, measured 2026-08-28)

~105 runs over ~4 weeks → 20 MB `apo.db` holding ~1.2 MB of live table data (the rest is WAL/freelist/index overhead), 16 KB of artifact objects, and **53 MB of manual migration backups** in `data/backups/` (`apo-before-normalizer-v5-*` etc. — operator-made copies, nothing in the code writes or prunes them). Usage is tiny; the point is the **shape**: even smoke-scale runs already average ~10 KB/run of table data, and every big-payload column below is unbounded per row.

### What grows, and how fast

Growth key: RUN = per task run, SPAN = per trace span, REQ = per OTLP HTTP request, TICK = per schedule due-time, USER = per user action.

| Data | Grows | Payload reality | Bounded? |
|---|---|---|---|
| `otlp_ingest_batches` | REQ | **full decoded OTLP JSON payload, up to 10 MiB per request** (`otlp_receiver.py:282-290`; "all received Trace Content is stored in full", `otlp_receiver.py:256-258`) | per-request cap only |
| `otlp_spans` | SPAN | lossless `raw_span` + `attributes`/`events`/`links`/`resource` JSON | no truncation |
| `logged_calls` | SPAN | `input`, `messages`, `output`, `tool_result` written verbatim (`trace_projector.py:299-317`) | none (only the 10 MiB request cap upstream) |
| `runs` | RUN | trace-level `input`/`output` JSON | none |
| `agent_task_runs` | RUN | **`transcript_json` written verbatim, uncapped** (`agent_task_runner.py:444-448` — "still written (no replacement storage yet)") | none |
| `agent_task_check_reports` | RUN | `value_json` evidence; `received` > 4 KiB and judge segments > 16 KiB truncated to markers (`check_report_storage.py:38-39,156-209`) | partial hygiene ✓ |
| `agent_task_judgments` | USER/rejudge | `checks_json` stored **verbatim from the request body** — the rejudge path skips `normalize_check_report` (`agent_task_judgments.py:167`) | none |
| `agent_task_deliverables` | RUN × item | inline JSON ≤ 64 KiB, else artifact object (≤ 100 MiB/item, 500 MiB/run) on disk (`agent_task_deliverables.py:47-48`, `artifact_stores/registry.py:21-22`) | yes ✓ |
| `task_definition_revisions` | per task-content change | full `*.eval.ts` source text, deduped by content hash | never deleted |
| `task_execution_attempts` | RUN | `stdout_tail`/`stderr_tail` capped at 64 KiB each (`execution_finalization.py:39-40`) | yes ✓ |
| `agent_task_schedule_occurrences` | TICK | one row per due time (~365/yr per daily schedule) | never deleted |
| comments, reactions, task-view comparisons, expired tokens/invitations | USER | small rows, unbounded count | never deleted |

### What the existing mechanisms actually cover

1. **`APO_RETENTION_DAYS` (default 0 = off)** — daily thread; trace side deletes only `call_metrics`, `logged_calls`, `run_metrics`, `runs` (bookmark-protected); batch side (via the shared cascade) deletes attempts, check reports, judgments, corrections, deliverable rows **and their stored objects**, runs, task revisions **and bundle objects**, batches (`retention.py:53-93,113-191`). It does **not** touch `otlp_spans`, `otlp_ingest_batches`, `task_definition_revisions`, occurrences, comments, or any token/invitation table. Two latent defects: purging a batch that is still referenced by a schedule or occurrence can FK-fail because the purge, unlike manual run deletion, never detaches `agent_task_schedules.active_batch_run_id` / occurrences (`retention.py:171-191` vs `run_deletion._detach_batch_references`); and a bookmarked trace survives its batch purge **orphaned**.
2. **`APO_MAX_DB_PAGES` (default 0 = off)** — `PRAGMA max_page_count`; at the cap writes fail with `SQLITE_FULL`, which nothing catches or explains to the user.
3. **Artifact upload TTL** (`cleanup_expired_artifact_uploads`, `retention.py:291-333`) — handles abandoned pending uploads only, and is **dead code**: no loop or route ever calls it (only tests).
4. **Manual run/batch deletion** (shipped 2026-08-28) — the most complete per-run cascade: adds `otlp_spans` and schedule-reference detach on top of the purge; still keeps ingest-batch rows (only nulls the soft `verified_task_run_id` link).
5. **Project deletion / reset-db** — full-cascade, one-shot, not retention.

### The never-cleaned list (grows even with retention ON)

1. `otlp_ingest_batches` raw payloads — **the worst offender by far**: a permanent second copy of every trace, up to 10 MiB per request, kept "for replay" forever with no replay-trim.
2. `otlp_spans` — retention never deletes them; only manual run deletion or project deletion do.
3. `task_definition_revisions` — every distinct task edit's full source, forever.
4. `agent_task_schedule_occurrences` + `adaptive_task_states` (the latter orphaned even by schedule deletion).
5. `transcript_json` and rejudge `checks_json` — unbounded inline JSON per run/judgment.
6. Comments/reactions, task-view comparison snapshots, expired tokens/invitations/enrollment tokens.
7. Orphans manufactured by existing paths: `POST /v1/runs/bulk-delete` leaves `call_metrics` behind; expired pending uploads never reaped (dead code above).

### Config knobs

Documented in `apps/docs .../self-hosting/configuration`: `APO_RETENTION_DAYS` (0), `APO_MAX_DB_PAGES` (0), `APO_ARTIFACT_*` (dir, 100 MiB/item, 500 MiB/run, upload TTL 86400s). **Undocumented**: all telemetry caps (`APO_TELEMETRY_MAX_REQUEST_BYTES`, `APO_OTLP_MAX_DECOMPRESSED_BYTES`, `APO_OTLP_MAX_SPANS_PER_REQUEST`, rate limits — `telemetry_limits.py:34-36,113-121`).

## Part 2 — how other products handle it

### Langfuse (code-verified in `../langfuse`)

- **Architecture**: ClickHouse for traces/observations/scores (monthly partitions on event time, `ORDER BY (project_id, day, id)`, ZSTD(3) on I/O columns, `ReplacingMergeTree(event_ts, is_deleted)`); Postgres as control plane only; S3/MinIO for media blobs; Redis/BullMQ worker queues.
- **Retention is a per-project setting, executed by a nightly cron**: `Project.retentionDays` → repeatable job `15 3 * * *` fans out one job per project; the job **re-fetches the current setting at execution time** so a stale queued job can't delete data after the admin raised/disabled retention (`worker/src/ee/dataRetention/`). Deletion is a plain time-bounded `DELETE FROM traces WHERE project_id = ? AND timestamp < cutoff` (ClickHouse lightweight delete).
- **No TTLs on the fact tables** — the only table TTLs are on a 48-hour ingestion staging table; a TTL'd aggregate experiment was added and then rolled back.
- **Batch deletion is a two-phase ledger**: UI writes tombstones to `pending_deletions` in Postgres, enqueues a job with a 5 s delay so deletes coalesce, worker deletes in batches of ~2000, marks the ledger done; a periodic sweeper clears backlogs. Crash-safe and idempotent.
- **Defaults**: OSS self-host = indefinite (the UI says "Set to 0 to retain data indefinitely"); the retention UI is cloud/EE-entitlement-gated, min 3 days. Cloud read windows: Hobby 30 d, Core 90 d, Pro 3 years ([docs](https://langfuse.com/docs/administration/data-retention)).
- **Escape hatch before deletion**: scheduled **blob-storage export** (S3/GCS/Azure) — "preserving data requires setting up Blob Storage Export"; deleted data is unrecoverable ([docs](https://langfuse.com/docs/administration/data-retention)). Self-hosters with versioned buckets handle non-current versions via lifecycle rules.
- **Scale tricks**: a narrow MV-projected "core" table with 200-char truncated I/O for list queries (full payloads fetched only on drill-down); raw ingestion events optionally parked as S3 files with only refs in ClickHouse; hourly pre-aggregated analytics views.

### LangSmith

- SaaS: extended traces retained **400 days** (Enterprise-customizable); datasets are kept indefinitely; low-retention traces are billed cheaper and evaluators/automation can promote a trace to a longer window ([pricing](https://www.langchain.com/pricing), [admin overview](https://docs.langchain.com/langsmith/administration-overview)).
- Self-hosted has an explicit **automatic TTL / data-retention** toggle for compliance-driven deletion ([self-host TTL](https://docs.langchain.com/langsmith/self-host-ttl)).
- Bulk **export before purge** is a first-class path (72 h runtime cap on exports) ([export docs](https://docs.langchain.com/langsmith/data-export)).

### Arize Phoenix

- Self-hosted default is **indefinite** ("0 days"), changed via `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS` or per-project **retention policies** that are **time-based *or* trace-count based** (keep the most recent N traces) ([data retention](https://arize.com/docs/phoenix/settings/data-retention)). Upgrades pin pre-existing projects to infinite retention so nothing is silently deleted.

### Braintrust

- Plan-driven: base log retention **14–30 days**, longer windows billed ($0.50/GB/mo beyond 30 d), per-project/environment automated policies (e.g. 7 d dev, 90 d prod) ([retention](https://www.braintrust.dev/docs/admin/data-management/retention), [plans](https://www.braintrust.dev/docs/plans-and-limits)).

### Classic APM norm

- Datadog traces **15 days** by default, customizable to 30–60 ([trace retention](https://docs.datadoghq.com/tracing/trace_pipeline/trace_retention/)); Honeycomb advertises 60 days (marketing comparison pages — treat as directional). Indexed-span retention and raw-span retention are priced/tiered separately.

### Patterns across all of them

1. **Self-hosted defaults to keep-forever; bounded retention is always an explicit, visible choice.** Nobody silently deletes.
2. **Retention is per-project (tenant) and time-based**, executed as a periodic job, always **re-validating the setting at execution time**.
3. **Tiered value**: compact verdict/metadata lives long (LangSmith datasets indefinite, Honeycomb metrics 13 mo); fat raw payloads live short (14–90 d norms).
4. **Export-before-delete** is the standard compromise when retention hurts (Langfuse blob export, LangSmith bulk export).
5. **Deletion is asynchronous, batched, idempotent, and reclaims disk eventually** (Langfuse's ledger + cleaners + mask-compaction;apo's VACUUM is the SQLite analog).

## Part 3 — recommendation sketch for apo

The product fact that should drive the design: **apo's long-lived value is the verdict history (tiny), not the raw evidence (95% of the bytes, decaying debugging value)**. A regression timeline over months needs `passed/failed` + costs; it almost never needs last month's 10 MiB OTLP payloads.

1. **Close the coverage gaps first** (mechanical, no product decisions needed):
   - Purge/trim `otlp_ingest_batches`: the payload is a replay inbox — give it its own short TTL (e.g. 7 d) or store payloads as artifact objects instead of inline Text; either way stop keeping a permanent second copy of every trace.
   - Teach the retention purge to delete `otlp_spans` (reuse `run_deletion._delete_trace_projection`), detach schedule/occurrence references before batch deletes (fixes the FK hazard), and reap expired pending uploads by actually wiring `cleanup_expired_artifact_uploads` into the loop.
   - Schedule deletion should take its occurrences and adaptive states with it; add token/invitation/occurrence reaping to the daily loop.
2. **Two-tier retention as the product concept**: `APO_VERDICT_RETENTION_DAYS` (default: forever — verdict rows are tiny) and `APO_EVIDENCE_RETENTION_DAYS` (default: forever too, but a sane documented one-liner like 30/90 gets eval-history + bounded disk). Evidence tier = spans, ingest payloads, transcripts, logged-call I/O, check-report evidence docs, deliverable objects. This matches the LangSmith datasets-vs-traces split and keeps apo's "regression timeline" identity intact.
3. **Per-project retention in the UI later** (Langfuse's `retentionDays` pattern, admin-only, nightly job, re-validate at execution). Env knobs first, project setting second — apo is single-tenant-self-hosted today.
4. **Export before delete**: a `apo runs export` / trace bundle dump should exist before any default-short retention is even considered; Langfuse's docs put this bluntly — deleted means unrecoverable.
5. **Make size visible**: a storage page (or `apo status` extension) reporting per-table/per-tier bytes + what the current policy would delete — `get_db_size_info` already exists but is report-only and unexposed. Also decide what `SQLITE_FULL` should do besides 500 (reject ingestion with a clear error, protect the verdict tier).
6. **Housekeeping**: document the telemetry caps; consider pruning `data/backups/` guidance (53 MB of stale migration snapshots on this stack already); keep transcript/`checks_json` inline-cap on the write path as a follow-up (the check-report hygiene markers are the model to copy).

## See also

- `backend/apo/services/retention.py` — current purge + size cap.
- `backend/apo/services/run_deletion.py` — the complete per-run cascade (the coverage baseline retention should converge to).
- [Langfuse data retention](https://langfuse.com/docs/administration/data-retention) · [Langfuse ClickHouse self-hosting](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse) · [LangSmith self-host TTL](https://docs.langchain.com/langsmith/self-host-ttl) · [Phoenix data retention](https://arize.com/docs/phoenix/settings/data-retention) · [Braintrust retention](https://www.braintrust.dev/docs/admin/data-management/retention) · [Datadog trace retention](https://docs.datadoghq.com/tracing/trace_pipeline/trace_retention/)
