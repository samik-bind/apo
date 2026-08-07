# Self-Hosted Alpha Topology

The agent-testing platform has exactly **one supported self-hosted topology for
alpha**: a single node with separate frontend, Control Plane, and Bundled
Executor processes. This keeps Task code and provider secrets out of FastAPI
without adding a queue broker.

## Supported shape

```
                 ┌────────────────────────┐
                 │  Reverse proxy / TLS    │
                 │  (Caddy, nginx, Traefik)│
                 └──────────┬─────────────┘
                            │ HTTPS
                            ▼
        ┌───────────────────────────────────────────┐
        │  One host (VM or bare metal)              │
        │                                           │
        │  ┌─────────────┐    ┌──────────────────┐  │
        │  │  frontend   │◀──▶│ Control Plane    │  │
        │  │  dashboard  │    │ API + scheduler  │  │
        │  └─────────────┘    └────────┬─────────┘  │
        │                              │ HTTP pull   │
        │                     ┌────────▼─────────┐  │
        │                     │ Bundled Executor │  │
        │                     │ Task subprocess │  │
        │                     └──────────────────┘  │
        │  ┌────────────┐  ┌─────────────────────┐ │
        │  │ SQLite or  │  │ persistent source, │ │
        │  │ Postgres   │  │ artifact + state   │ │
        │  └────────────┘  └─────────────────────┘ │
        └───────────────────────────────────────────┘
```

Components:

| Component | Alpha role |
|-----------|-----------|
| Reverse proxy | TLS termination, single ingress, no path-based routing tricks. |
| Frontend dashboard (Next.js) | One container, one replica. |
| Backend / Control Plane | One container, **one replica**. Owns API, scheduler, queue/leases, Runs, and authorization. Never executes Task code. |
| Bundled Executor | Private container. Pulls work outbound and owns dependency installation + Task subprocesses. |
| Database | SQLite is the supported default. Postgres is an explicit opt-in for longer-lived shared installations or heavier concurrent writes. |
| Persistent volumes | Database data + task-source cache must survive container restarts. |

## What is explicitly unsupported in alpha

- Two or more backend replicas (the in-memory rate limiter and SSE broadcaster require a single process; multi-replica needs Redis, which is out of scope).
- Stateless / horizontally scaled managed execution.
- Kubernetes manifests and multi-region deploys.
- Queue brokers (Redis, RabbitMQ, SQS, etc).

If you need any of the above, you are outside the alpha contract.

## Deployment profiles

| Profile | Reachability | Start command |
|---|---|---|
| Local | This machine only; ports bind to `127.0.0.1` | `docker compose up -d --build` |
| Server | Public HTTPS domain through Caddy | `docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build` |

The Server Profile makes one installation reachable by browsers, the CLI, and
sandboxed agents. Caddy is the included reference ingress; an existing nginx,
Traefik, tunnel, or load balancer can replace it by forwarding to the frontend.

## Local deploy path

This is the canonical alpha deploy path. It assumes Docker and Docker Compose on a single host.

1. **Create an env file** with strong secrets:

   ```bash
   cat > .env <<EOF
   AUTH_SECRET=$(openssl rand -hex 32)
   APO_DEPLOYMENT_PROFILE=local
   APO_PUBLIC_URL=http://localhost:3000
   SCHEDULER_ENABLED=true
   EOF
   ```

   The unquoted `EOF` is intentional: it evaluates `openssl` and writes the
   generated secret, not the literal command.

2. **Bring up the default SQLite stack:**

   ```bash
   docker compose up -d --build
   ```

   SQLite data is persisted in the `apo_db` Docker volume. Use the Postgres
   override below when you want Postgres; it is not required to try apo or run
   a small alpha team.

3. **Wait for readiness** — the backend healthcheck uses `/health/ready`, which verifies the database, artifact store, and auth secret are actually usable:

   ```bash
   curl -fsS http://localhost:8000/health/ready | jq
   ```

   Expect `{"ok": true, "checks": {...}}`. A 503 with a `checks` payload tells you exactly which prerequisite failed.

4. **Create the first admin user.** Either visit the dashboard and walk the account-creation flow, or — for headless first boot only — set `INIT_USER_EMAIL` / `INIT_USER_PASSWORD` / `INIT_USER_NAME` env vars on the backend. The bootstrap runs once (idempotent — no-op when any users exist). **These env vars are unset by default**; operators set them explicitly when they want a headless first boot, never as a baked-in default.

After the first user exists, all further onboarding goes through normal account creation + project invite (see Settings → Members). Invitations are copy-link by default — no email setup needed (see [Email delivery](#email-delivery-optional)). Do not rotate `INIT_USER_*` to provision additional users — that path is closed by the idempotency check.

## Publish the Server Profile

Point a hostname such as `apo.example.com` at the Docker host, allow inbound
TCP 80/443, and set the public profile in `.env`:

```bash
APO_DEPLOYMENT_PROFILE=server
APO_PUBLIC_URL=https://apo.example.com
```

Start the base stack with the Caddy override:

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

Caddy obtains and renews HTTPS automatically. The frontend and backend keep
their loopback-only diagnostic ports; only Caddy accepts internet traffic.
From a different machine, prove all three public routes:

```bash
scripts/public-ingress-smoke.sh https://apo.example.com
```

```text
public ingress: ok
  dashboard: https://apo.example.com/
  API:       https://apo.example.com/backend-proxy
  OTLP:      https://apo.example.com/api/public/otel/v1/traces
```

Configure the CLI with
`APO_BACKEND_URL=https://apo.example.com/backend-proxy` and telemetry exporters
with `APO_OTLP_ENDPOINT=https://apo.example.com/api/public/otel/v1/traces`.

## Email delivery (optional)

Email is **off by default** (log-only). The platform works fully without it — no provider, no credentials, no DNS setup required to get started.

**Without email configured:**

- **Signup is instant** — email verification is off by default (`AUTH_EMAIL_VERIFICATION_REQUIRED=false`), so new accounts are active immediately.
- **Invitations are copy-link** — the dashboard hands you a join link to paste to a teammate (Slack, email, whatever). They accept at `/accept-invitation?token=…` and join, or create an account if they don't have one yet.
- **Password reset is admin-assisted** — ask the user to submit the **Forgot
  password** form, then read the generated link from the backend logs:

  ```bash
  docker compose logs backend | grep 'Reset URL:'
  ```

  ```text
  backend-1 | ... Reset URL: https://apo.example.com/reset-password?token=...
  ```

  Send the one-hour link to the user privately.

**To enable delivery** (fully optional, provider-agnostic) set two env vars and restart the backend:

```bash
EMAIL_TRANSPORT_URL=smtp://USER:PASS@smtp.provider.com:587
EMAIL_FROM_ADDRESS=noreply@yourdomain.com
# optional:
EMAIL_FROM_NAME=apo
```

- `smtp://…` works with **any** SMTP provider (Resend, Brevo, Mailgun, Gmail, …).
- `ses://us-east-1` uses **AWS SES** (boto3). Both transports are built in.
- Port `465` = implicit TLS, `587` = STARTTLS (auto-detected; override with `EMAIL_SMTP_TLS=true/false`).

Turning it on instantly lights up all senders: invitation emails, verification codes (set `AUTH_EMAIL_VERIFICATION_REQUIRED=true` if you want to require them), and password-reset links.

**Deliverability:** to land in inboxes rather than spam, send from a domain you own and add the SPF/DKIM/DMARC records your provider generates. A quick free option is [Resend](https://resend.com) (3,000 emails/month, 100/day free) — sign up, verify your domain, and point `EMAIL_TRANSPORT_URL` at its SMTP relay.

## Readiness endpoint

`GET /health/ready` is the operator-grade probe. It returns 200 when the deployment is actually usable and 503 otherwise. Checks include:

- **database** — can the backend reach the configured `DATABASE_URL`?
- **auth_secret** — present, non-placeholder, and at least 16 characters when not in dev mode.
- **artifact_store** — Revision Bundles and Artifacts can be persisted.

This endpoint is intentionally separate from the basic `/health` liveness probe, which only confirms the process booted.

## Runtime config endpoint

`GET /v1/system/runtime-config` (admin-only) returns:

```json
{
  "backend_url": "http://backend:8000",
  "frontend_url": "http://frontend:3000",
  "database": {
    "engine": "sqlite",
    "host": null,
    "name": "//app/data/apo.db",
    "credentials_configured": false,
    "shared_use_recommended": false
  },
  "task_source_cache_dir": "/var/lib/apo/task-sources",
  "task_execution_mode": "executor_pools",
  "scheduler_enabled": true,
  "supported_topology": "single-node-alpha"
}
```

The `database` field is a sanitized descriptor — credentials are never
exposed through this endpoint, even to admins. This is surfaced in the
dashboard at **Settings → System → Deployment Topology**.

## Task execution dependencies

Real synced Git sources almost always need dependencies before `runner.mjs`
can load their task modules. The Executor performs this deterministic install
inside its private workspace before importing Task code.

### Policy

| Question | Answer |
|----------|--------|
| When does install happen? | Lazily, before each task run, but only when the lockfile hash has changed since the last successful install. |
| What lockfiles are supported? | Node: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`. Python: `pyproject.toml` + `uv.lock` / `poetry.lock`, or `requirements.txt`. |
| Where is the cache? | `<TASK_SOURCE_CACHE_DIR>/installs`, keyed by workspace path + every lockfile's content hash. |
| What commands are used? | `npm ci --no-audit --no-fund`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `uv sync --frozen`, `poetry install --no-root`, `pip install -r requirements.txt`. |
| What timeout applies? | `TASK_INSTALL_TIMEOUT_SECONDS` (default 180s, clamped to minimum 30s). |
| How do I disable it? | `TASK_INSTALL_DISABLE=true` — escape hatch for air-gapped deploys that pre-install dependencies in the image. |
| How do failures surface? | The Attempt fails as `dependency_install_failed` with bounded diagnostics. The Control Plane remains healthy. |

### Operator notes

- The Executor image must include every package manager your synced sources need (`node`, `npm`, `pnpm`, `yarn`, `python`, `uv`, `poetry`).
- The install cache should live on a persistent volume so it survives container restarts. The default location already inherits from `TASK_SOURCE_CACHE_DIR`, so the Compose `task_source_cache` volume covers it.
- If a source repo intentionally ships without a lockfile (e.g. the bundled example-service tasks that rely on the SDK resolved via the monorepo), no install runs and execution proceeds normally.

## Choose a database

The default Docker stack uses SQLite in the persistent `apo_db` volume. It is
the supported default for trials and small single-node alpha teams.

Choose Postgres for a longer-lived shared installation, heavier concurrent
writes, or when your operations already standardize on Postgres:

```bash
printf '\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=apo\n' "$(openssl rand -hex 16)" >> .env
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

The Postgres override changes only the database. It does not make multiple apo
backend replicas safe; both database choices retain one backend and one scheduler owner.

## Scheduler ownership

Alpha assumes **one backend process owns the scheduler**. The in-process dispatcher starts in the FastAPI lifespan and is controlled by `SCHEDULER_ENABLED`:

- `SCHEDULER_ENABLED=true` (default) — schedules dispatch normally.
- `SCHEDULER_ENABLED=false` — schedules remain visible but do not fire. The system settings page reflects this clearly.

Never run two backend processes with `SCHEDULER_ENABLED=true` against the same database; you will get duplicate dispatch.

## Cost-aware defaults

Alpha defaults are intentionally cheap:

- **One node.** Do not provision extra capacity unless you see real pressure.
- **SQLite first.** Move to Postgres when sustained concurrent writes or your
  operational requirements justify the extra service.
- **Cheap default model** for agent tasks (`google/gemini-2.5-flash-lite` via OpenRouter by default; override with `AGENT_TASK_OPENROUTER_MODEL`).
- **Conservative schedules** — adaptive cadence defaults to ≥ 1 day between runs.
- **Log rotation** is already configured in every Compose service (`max-size: 10m`, `max-file: 3`). Add cache pruning via cron if you sync many large Git sources.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| The backend still behaves like an older checkout after `docker compose up --build` | The source checkout was stale, the image build did not complete, or the existing backend container was not recreated. A container restart alone reuses its old image. | From the repository root, update the checkout, run `docker compose build backend`, then `docker compose up -d --no-deps --force-recreate backend`. Confirm the image and container creation times with `docker compose images backend` and `docker compose ps backend`. Preserve the database volume; never use `down -v` for an application update. |
| `/health/ready` returns 503 with `auth_secret` failing | You left `AUTH_SECRET` set to the placeholder or unset in non-dev mode. | Generate a strong secret with `openssl rand -hex 32`. |
| `executor` service restart-loops; backend logs `Bundled executor is enabled but the bootstrap token file could not be written` | The `apo_executor_bootstrap` named volume was created root-owned (a stack created before the Dockerfile seeded the mountpoint as `appuser`). | Run `docker compose run --rm --user 0:0 backend chown -R 1000:1000 /var/lib/apo/executor-bootstrap`, or remove the volume (`docker volume rm apo_executor_bootstrap`) and recreate the stack. Fresh stacks built from the current image are unaffected. |
| Schedules visible but never fire | `SCHEDULER_ENABLED=false`. | Either set it to `true` (one backend process only) or run an external dispatcher. |
| Attempt fails because the task runtime is unavailable | The Executor image is missing the packaged runtime. | Rebuild or replace the Executor image; the backend remains healthy. |
| Tasks fail with "Task dependency install failed" | The synced Git source's lockfile requires a package manager that isn't in the backend image (e.g. `pnpm`, `uv`), or the install command returned non-zero. | Bake the missing package manager into the image; or set `TASK_INSTALL_DISABLE=true` and pre-install dependencies in the source repo. |
| Tasks fail with "Task dependency install timed out" | The workspace has a large dependency tree. | Raise `TASK_INSTALL_TIMEOUT_SECONDS` or pre-install dependencies in the image. |
| SQLite shows sustained lock contention or write latency | The installation has outgrown the default database profile. | Back up the installation, configure the Postgres override, and migrate the data deliberately. Do not use `docker compose down -v`; it deletes volumes. |

## Operator checklist

Before declaring an internal alpha instance production-ready for coworkers:

- [ ] One host, one backend container, one scheduler owner.
- [ ] `AUTH_SECRET` is a strong random value (not the placeholder).
- [ ] The chosen database profile matches the expected write load; SQLite is
      supported for a small alpha, while Postgres is preferred for sustained
      shared use.
- [ ] `task_source_cache` is on a persistent volume.
- [ ] Reverse proxy terminates TLS with a valid certificate.
- [ ] `/health/ready` returns 200 from outside the host.
- [ ] System settings → Deployment Topology shows the values you expect.
- [ ] At least one end-to-end task run has been completed successfully.
