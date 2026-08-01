---
title: Configuration
description: "Every environment variable across backend, CLI, SDK, and the task runner."
---

apo is configured through environment variables — no config files. This page is the complete reference. For operator guidance (databases, scheduler ownership, email, troubleshooting), see [Self-Hosting: Configuration](/self-hosting/configuration/).

## Backend

The backend reads these on start. Set them in `backend/.env` (or your container env).

### Required for non-dev

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | Session signing secret. **Required for any non-dev deploy.** Empty in dev → open-dev mode (auth bypassed). Generate with `openssl rand -hex 32`. Must be ≥16 chars, not a placeholder. |
| `DATABASE_URL` | Database DSN. When unset, apo uses its persistent SQLite file; this is the supported default for trials and small single-node alpha teams. The optional Compose Postgres profile sets a `postgresql://...` DSN for longer-lived shared installations or heavier concurrent writes. |

### LLM (agent-task runs)

These defaults are deliberately cheap (`google/gemini-2.5-flash-lite`) —
stronger models are opt-in only. Put provider credentials on the Executor
service, not the Control Plane. Only allow-listed variables enter Task
subprocesses:

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | OpenRouter API key. Required for LLM-judge checks and adapter LLM calls. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter-compatible base URL. |
| `OPENROUTER_MODEL` | — | OpenRouter model for local/dev runs. Read by the SDK when `AGENT_TASK_OPENROUTER_MODEL` is unset. |
| `AGENT_TASK_OPENROUTER_MODEL` | `google/gemini-2.5-flash-lite` | Default model for Executor Task subprocesses. Falls back to `OPENROUTER_MODEL`, then `google/gemini-2.5-flash`. |
| `OPENAI_API_KEY` | — | OpenAI API key. Alternative to OpenRouter for local/dev judge calls. |
| `OPENAI_BASE_URL` | — | OpenAI-compatible base URL. |
| `OPENAI_MODEL` | — | OpenAI model for local/dev judge calls. Read when `OPENROUTER_MODEL` is unset. |

### Scheduler

| Variable | Default | Purpose |
|---|---|---|
| `SCHEDULER_ENABLED` | `true` | Set `false` to disable schedule dispatch. Schedules stay visible but don't fire. **Never run two backends with this `true` against the same database** — the scheduler is in-process and single-owner. |

### Executors

| Variable | Default | Purpose |
|---|---|---|
| `APO_BUNDLED_EXECUTOR_ENABLED` | `false` outside Compose; `true` in Compose | Bootstrap the installation-scoped Bundled Executor and Project Pools. |
| `APO_CONTROL_PLANE_URL` | — | Executor-only base URL for outbound protocol calls. Required by the Executor. |
| `APO_EXECUTOR_STATE_DIR` | `/var/lib/apo-executor` | Persistent supervisor-owned identity directory. |
| `APO_EXECUTOR_MAX_CONCURRENCY` | `1` | Executor capacity. |
| `APO_EXECUTOR_DRIVER` | `subprocess` | Driver advertised by this Executor. |
| `APO_EXECUTOR_TASK_USER` | `appuser` | OS user used for Task subprocesses. |
| `APO_TASK_ENV_ALLOWLIST` | empty | Exact provider variables copied into Task children. |
| `APO_EXECUTOR_IMAGE` | current exact version | Connected enrollment command image override. |
| `APO_EXECUTOR_CONTROL_PLANE_URL` | `<APO_PUBLIC_URL>/backend-proxy` | Public URL rendered for Connected enrollment. |

### Task source

| Variable | Default | Purpose |
|---|---|---|
| `TASK_SOURCE_CACHE_DIR` | `<repo>/.cache/task-sources` | Writable dir for cloned Git task sources. Mount a persistent volume in container deploys. |
| `TASK_SOURCE_GIT_TIMEOUT_SECONDS` | `60` | Per-clone/fetch timeout. |
| `TASK_INSTALL_DISABLE` | `false` | `true`/`1` skips dependency install (escape hatch for air-gapped deploys). |
| `TASK_INSTALL_TIMEOUT_SECONDS` | `180` | Per-install timeout (min 30s). |
| `TASK_INSTALL_CACHE_DIR` | `<TASK_SOURCE_CACHE_DIR>/installs` | Where install markers live. |

### URLs

| Variable | Default | Purpose |
|---|---|---|
| `BACKEND_URL` | `http://127.0.0.1:8000` | Backend URL for CORS, redirects, and runtime config; the frontend also uses it for direct server-rendered requests. In Compose this is the internal service URL (`http://backend:8000`), not the public dashboard origin. |
| `FRONTEND_URL` | `http://localhost:3000` | Frontend URL (CORS, redirects). |

### Email (optional)

Off by default. The platform works fully without email. To enable delivery:

| Variable | Purpose |
|---|---|
| `EMAIL_TRANSPORT_URL` | `smtp://USER:PASS@smtp.provider.com:587` (any SMTP) or `ses://us-east-1` (AWS SES). |
| `EMAIL_FROM_ADDRESS` | From address. |
| `EMAIL_FROM_NAME` | From name (optional, defaults to "apo"). |

### GitHub OAuth (optional)

When all four are set, projects get a "Connect GitHub" button for private-repo task sources. When any is missing, only the manual URL-paste flow is available.

| Variable | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` | OAuth App client id (`iv1...`). |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret. |
| `GITHUB_REDIRECT_URI` | Callback URL (e.g. `http://localhost:8000/v1/github/callback`). |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | Fernet key for encrypting stored tokens. Generate: `uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. |

## CLI

The `apo` CLI reads these. Precedence: flag > env > stored credentials (`~/.apo/credentials`).

| Variable | Purpose |
|---|---|
| `APO_TASK_ROOT` | Directory to scan for tasks (default `./e2e`). |
| `APO_BACKEND_URL` | Backend URL (default `http://localhost:8000`). |
| `APO_PROJECT_ID` | Active project id. |
| `APO_ACTOR` | Actor name for runs (who triggered them). |
| `APO_API_KEY` | API key for backend auth. |

### Langfuse connector (`apo traces import langfuse`)

:::caution
These variables are read **only** by the CLI for the [`traces import langfuse`](/cli/traces-import-langfuse/) command. They are never sent to apo, logged, persisted to `~/.apo/credentials`, or attached to the imported trace. There is intentionally no `--langfuse-secret-key` flag.
:::

| Variable | Required | Purpose |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | yes | Langfuse project public key for the source trace. |
| `LANGFUSE_SECRET_KEY` | yes | Langfuse project secret key for the source trace. |
| `LANGFUSE_HOST` | no | Source Langfuse deployment (default `https://cloud.langfuse.com`). Overrideable with `--langfuse-host`. |

## SDK (`@apo/sdk`)

The tracing SDK reads these environment variables:

| Variable | Purpose |
|---|---|
| `APO_BACKEND_URL` | Backend URL. Also `NEXT_PUBLIC_APO_BACKEND_URL`. |
| `APO_PROJECT` | Project id. Also `NEXT_PUBLIC_APO_PROJECT`. |
| `APO_PUBLIC_KEY` | Public identifier (`pk-apo-…`) for HTTP Basic auth. Server-side only — pair with `APO_SECRET_KEY`. |
| `APO_SECRET_KEY` | Secret key (`sk-apo-…`) for HTTP Basic auth. Server-side only. |
| `APO_API_KEY` | Legacy single-key auth (alternative auth). |
| `APO_AUTH_TOKEN` | Bearer token for short-lived task-run/attempt tokens, or secret-bearing legacy keys. |

`NEXT_PUBLIC_APO_PUBLIC_KEY` is intentionally **not** read. The
public identifier does not authorize ingestion by itself, and publishing
it in a browser bundle creates a misleading direct-browser integration.
Telemetry submission requires both halves of an API-key pair encoded as
HTTP Basic. There is no supported browser-public ingestion credential.

## Task runner (Executor subprocess)

These are set automatically by an Executor. The Control Plane never spawns
Task subprocesses. The child receives task-scoped values and allow-listed
provider configuration, never the long-lived Executor credential, enrollment
token, database DSN, source OAuth token, or ArtifactStore credentials.

| Variable | Purpose |
|---|---|
| `AGENT_TASK_DIR` | The task folder being run. |
| `AGENT_TASK_PROJECT` | Project context (default `"default"`). |
| `AGENT_TASK_RUN_ID` | The run id this subprocess belongs to. |
| `AGENT_TASK_TRACE_ENDPOINT` | Where the subprocess sends trace data. |
| `AGENT_TASK_TRACE_REQUIRED` | Whether tracing is mandatory for this run. |
| `AGENT_TASK_RUN_METADATA` | JSON metadata attached to the run. |
| `AGENT_TASK_ENVIRONMENT` | The run environment label. |
| `APO_AUTH_TOKEN` | Auth token for the subprocess. |
| `AGENT_TASK_JUDGE_MODEL` | Override the judge model for this run. |
| `OPENROUTER_MODEL` | Passed through to the subprocess for LLM calls. |
| `OPENROUTER_BASE_URL` | Passed through to the subprocess. |

## Auth and sessions

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | — | Session signing secret (see Backend above). |
| `AUTH_SESSION_MAX_AGE_DAYS` | `7` | How long a login session stays valid. |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Max login attempts before lockout. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `300` | Lockout window length. |
| `AUTH_EMAIL_VERIFICATION_REQUIRED` | `false` | Require email verification before login. |
| `ADMIN_API_KEY` | — | Admin-level API key for privileged routes. |

## Bootstrap and retention

| Variable | Default | Purpose |
|---|---|---|
| `INIT_USER_EMAIL` | — | First-run admin email (seeds an account on startup). |
| `INIT_USER_PASSWORD` | — | First-run admin password. |
| `INIT_USER_NAME` | — | First-run admin display name. |
| `APO_RETENTION_DAYS` | `0` | Days to keep runs/traces. `0` disables automatic age-based deletion. |
| `APO_MAX_DB_PAGES` | `0` | SQLite page cap. `0` disables the cap. |
| `PROJECT_INVITATION_TTL_HOURS` | `168` | How long project invitations stay valid (7 days). |

## Task Run Deliverables and Artifacts

Deliverable metadata lives in the database; large JSON bodies and file
Artifacts flow through an `ArtifactStore`. The default `local` backend writes
under the existing persistent `/app/data` volume — no MinIO, Redis, or extra
container required. The optional `s3` backend keeps the same server API.

| Variable | Default | Purpose |
|---|---|---|
| `APO_ARTIFACT_STORE` | `local` | Write backend: `local` or `s3`. |
| `APO_ARTIFACT_DIR` | `<DATA_DIR>/artifacts` | Local object/staging root. |
| `APO_ARTIFACT_MAX_ITEM_BYTES` | `104857600` | 100 MiB per Artifact. |
| `APO_ARTIFACT_MAX_RUN_BYTES` | `524288000` | 500 MiB ready+pending per Task Run. |
| `APO_ARTIFACT_UPLOAD_TTL_SECONDS` | `86400` | Pending-upload expiry (orphan cleanup). |
| `APO_S3_BUCKET` | — | Required for S3 writes. |
| `APO_S3_REGION` | — | Optional; provider default otherwise. |
| `APO_S3_ENDPOINT_URL` | — | S3-compatible endpoint (R2, MinIO, Backblaze). |
| `APO_S3_PREFIX` | `artifacts/` | Private key prefix. |
| `APO_S3_ACCESS_KEY_ID` | — | Optional; credential chain otherwise. |
| `APO_S3_SECRET_ACCESS_KEY` | — | Paired with the access key. |
| `APO_S3_FORCE_PATH_STYLE` | `false` | MinIO-like path-style compatibility. |

Readiness (`/health/ready`) fails when the selected write backend is unusable.
Rows persist `storage_backend` so changing the write backend never reinterprets
existing rows — an installation must retain configuration for every backend
referenced by live rows.

:::warning
A database-only backup is **no longer complete** once object-backed
Deliverables exist. Back up `/app/data/artifacts` (local) or the configured
S3 bucket/prefix alongside the database, as part of the same backup
generation.
:::

## See also

- [Self-Hosting: Configuration](/self-hosting/configuration/) — operator guidance: databases, scheduler ownership, email setup, troubleshooting, the readiness probe.
- [CLI overview](/cli/) — the `apo` command surface.
