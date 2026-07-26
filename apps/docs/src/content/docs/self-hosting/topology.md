---
title: Alpha Topology
description: The single-node self-hosted topology supported for alpha.
---

The agent-testing platform has exactly **one supported self-host topology for alpha**:
one node with separate frontend, Control Plane, and Bundled Executor processes.
The split keeps Task code and provider secrets out of the API process without
adding a queue broker.

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

| Component | Alpha role |
|-----------|-----------|
| Reverse proxy | TLS termination and one public ingress. The Server Profile includes Caddy. |
| Frontend dashboard (Next.js) | One container, one replica. |
| Control Plane (FastAPI) | One container, **one replica**. Owns Projects, schedules, durable queue/leases, Runs, and authorization. It never executes Task code. |
| Bundled Executor | One private container by default. Pulls work outbound from the Control Plane and runs trusted-team Task subprocesses. |
| Database | SQLite is the supported default. Postgres is an explicit opt-in for longer-lived shared installations or heavier concurrent writes. |
| Persistent volumes | Database data + task-source cache must survive container restarts. |

## What is explicitly unsupported in alpha

- Two or more backend replicas (the in-memory rate limiter and SSE broadcaster require a single process; multi-replica needs Redis, which is out of scope).
- Stateless / horizontally scaled managed execution.
- Kubernetes manifests and multi-region deploys.
- Queue brokers (Redis, RabbitMQ, SQS, etc).

:::caution
If you need any of the above, you are outside the alpha contract. apo will break in subtle ways (duplicate dispatch, lost SSE events, stale rate-limit state) on a multi-replica backend.
:::

## Choose a deployment profile

| Profile | Reachability | Start command |
|---|---|---|
| Local | This machine only on `127.0.0.1:3000` | `docker compose up -d --build` |
| Server | Public HTTPS domain through Caddy | `docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build` |

Use [Publish Apo on Your Domain](/self-hosting/public-server/) for the complete Server Profile procedure and external smoke test.

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

   Expect `frontend`, `backend`, and `executor`. The backend creates one
   Bundled Pool per writable Project and enrolls the installation Executor
   through a one-time bootstrap file shared only by those two containers.

   SQLite data is persisted in the `apo_db` Docker volume. Executor identity
   is persisted separately in `apo_executor_state`. Use the
   [Postgres profile](/self-hosting/configuration/#choose-a-database) when you
   want Postgres; it is not required to try apo or run a small alpha team.

3. **Wait for readiness**: the backend healthcheck verifies Control Plane
   prerequisites. Executor availability is visible under **Settings →
   Executors** but does not make the API unready.

   ```bash
   curl -fsS http://localhost:8000/health/ready | jq
   ```

   Expect `{"ok": true, "checks": {...}}`. Then open **Settings → Executors**
   and confirm the Bundled Pool reports `online`.

4. **Create the first admin user.** Either visit the dashboard and walk the account-creation flow, or (for headless first boot only) set `INIT_USER_EMAIL` / `INIT_USER_PASSWORD` / `INIT_USER_NAME` env vars on the backend. The bootstrap runs once (idempotent: no-op when any users exist).

After the first user exists, all further onboarding goes through normal account creation + project invite. See [Configuration](/self-hosting/configuration/) for env vars and email delivery.

:::caution[Trusted process boundary]
The Bundled Executor separates customer Task code from FastAPI, but its
subprocess driver is not a hostile multi-tenant sandbox. Use it for trusted
self-hosted teams. Use a Connected Pool in the customer environment when
credentials or network access must stay outside the Apo host.
:::
