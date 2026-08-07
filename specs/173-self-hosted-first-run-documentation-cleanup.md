# SPEC-173: Self-Hosted First-Run Documentation Cleanup

## Overview

Make Apo's public entry path accurate and self-sufficient for a person who has
no existing Apo server and no access to the maintainer. A newcomer must be able
to understand the product, start a local Self-Hosted Installation, install the
published CLI and SDK, publish a Task Catalog, and run a Task by following one
chronological path built from commands that exist today.

This is a small documentation and documentation-contract repair. It does not
add a hosted Apo service, recruit users through product copy, or create a new
installer/runtime.

## Dependencies

- **SPEC-138: Public Self-Hosted Server Profile** — defines the optional public
  Server Profile. This spec keeps it secondary to the same-machine Local
  Profile for first use.
- **SPEC-159: Client-Published Task Catalog** — `apo task publish` is the only
  current Task Catalog publication path. Retired server-side Task Source sync
  commands must not appear in onboarding.
- **SPEC-161 through SPEC-168: Source-Owned Execution cutover** — Task code runs
  through one-shot Caller Execution or `apo connect`; the Compose stack no
  longer contains a Bundled Executor.
- **SPEC-170: Publish the TypeScript SDK to npm** — consumers install
  `@apo-ai/sdk` from npm rather than from the monorepo.
- Existing public packages:
  - `@apo-ai/cli`
  - `@apo-ai/sdk`
- Existing self-host helper: `scripts/self-host`.
- Existing public documentation build and verifier:
  - `apps/docs/package.json`
  - `apps/docs/scripts/verify-publication.mjs`
  - `apps/docs/src/pages/start.md.ts`
  - `apps/docs/src/content/docs/quickstart.mdx`

No backend, database, dashboard, SDK, CLI behavior, or deployment-topology
change is a dependency of this spec.

## Context

Apo is already usable without a maintainer-operated service: the repository is
public, the CLI and SDK are published, and the Local Profile runs the Control
Plane and dashboard on one machine. The public first-run story does not yet
describe that current system consistently.

Confirmed drift on current `main`:

1. `apps/docs/src/content/docs/quickstart.mdx` contains the literal placeholder
   `git clone <repo-url>` and runs `apo login` before installing the CLI.
2. `README.md` and `apps/docs/src/pages/start.md.ts` tell a fresh checkout to
   run `docker compose up -d --build` without first creating the required
   `AUTH_SECRET`. The existing safe path is `scripts/self-host init` followed by
   `scripts/self-host up --build`.
3. `README.md` and `guides/define-a-task.mdx` still use
   `apo project source sync`, which is absent from the current CLI. The live
   path is `apo task publish`.
4. The public Self-Hosting pages still describe an `executor` Compose service,
   a Bundled Executor, `task_source_cache`, and `apo_executor_state`. Current
   `docker-compose.yml` contains only `frontend` and `backend` in the base
   stack; Task source stays in the source-owning environment.
5. The CLI overview and Batch guide advertise removed commands including
   `apo batch create`, `apo project init-tasks`, `apo project source`, and
   `apo project sync-tasks`.
6. `packages/cli/README.md` leads with adding the executable as a project
   dependency even though the normal human path is a global install; the
   machine-local alternative is `npx`/package-manager execution.
7. `apps/docs/README.md` still calls the already-branded and publicly deployed
   docs site a default-Starlight proof of concept.

These are adoption failures, not missing product features. A newcomer should
not need to infer which generation of Apo the documentation describes.

## Locked Decisions

### 1. Self-hosting is the default no-server path

The human Quickstart and agent-readable `start.md` must say directly:

- Apo does not require or assume a maintainer-operated Apo server.
- A solo user starts the Local Profile on their own machine.
- A team may instead connect the CLI to a shared Self-Hosted Installation.
- The Server Profile is optional and belongs after local first success.

Do not imply that `test-apo.online`, the public docs host, or any other
maintainer-controlled endpoint is a service available to adopters.

### 2. Product documentation is not recruitment copy

Do not add requests for testers, design partners, feedback calls, waitlists,
testimonials, contact forms, or phrases such as "looking for users." The docs
explain Apo and let readers adopt it; outreach happens elsewhere.

### 3. One canonical first-run sequence

Every entry document must agree on this sequence:

```bash
# Start a local Self-Hosted Installation.
git clone https://github.com/samikuikka/apo.git
cd apo
scripts/self-host init --profile local
scripts/self-host up --build
curl -fsS http://localhost:8000/health/ready | jq

# Create the first account and Project in http://localhost:3000, then:
npm install -g @apo-ai/cli
apo login
apo project list

# In the source-owning application repository:
npm install @apo-ai/sdk
apo task publish --dir ./e2e
apo task run <task-id> --dir ./e2e
```

The exact Task root may differ in a real repository. The docs may use `./tasks`
or `./e2e`, but one page must not switch between roots without explanation.

`apo connect --dir <task-root>` is the next step for dashboard and Schedule
dispatch. It is not required for one-shot `apo task run` and must not be placed
before the first one-shot verdict.

### 4. Source-Owned Execution is the only documented current runtime

Public documentation must describe:

```text
Self-Hosted Installation       Source-owning application machine
------------------------       -------------------------------
frontend + backend             apo task run / apo connect
Control Plane + results   <->  real Task code + provider secrets
```

Task source, repository credentials, and provider secrets remain in the
source-owning application environment. The Control Plane coordinates Runs and
stores results, Traces, Tests, and Deliverables. There is no default server-side
Task runner or Bundled Executor container.

### 5. Explain necessary boundaries, not infrastructure history

The first-run pages must name the prerequisites and alpha limits that affect a
new user:

- Docker with Compose support for the Self-Hosted Installation;
- Node.js 20 or newer for the CLI and TypeScript SDK;
- a provider key only when the user's real agent or an LLM-backed Test needs
  one;
- a source-owning process must be running for dashboard/Schedule assignments;
- the supported deployment remains one backend replica.

Do not carry retired implementation history into the tutorial. Architecture
history belongs in specs/ADRs, not in first-run instructions.

## Interface

This spec changes the public documentation interface, not a product API.

### Human Quickstart

`apps/docs/src/content/docs/quickstart.mdx` remains a **tutorial**. It must:

1. Open with the result: start Apo locally, run one real Task, receive a binary
   verdict, and know where to inspect a failure.
2. List Docker Compose and Node.js 20+ before the first command.
3. Use the canonical sequence above with the exact public repository URL.
4. Show bounded expected output after every command group, including:
   - `init: generated AUTH_SECRET` (or the idempotent no-new-values form),
   - `doctor: ok` and the local dashboard URL,
   - a readiness response,
   - successful CLI login/project selection,
   - Task Catalog publication,
   - a pass or fail verdict with the command used to inspect the Run/Trace.
5. Explain first-account and first-Project creation explicitly. Do not promise
   that account creation silently creates a default Project.
6. Put `apo connect` after the one-shot result and explain why it is optional.
7. Link to the Task/Adapter guides for detail instead of duplicating their full
   reference material.

### Agent-readable setup document

`apps/docs/src/pages/start.md.ts` remains the complete AI-assisted setup
document. It must:

- make the Local Profile the default when no server URL was supplied;
- keep connecting to an existing team-operated server as a secondary branch;
- use `scripts/self-host` rather than raw Compose for fresh initialization;
- use only current CLI commands and Source-Owned Execution terms;
- tell the assisting agent to verify each step before proceeding;
- never instruct the agent to connect to a maintainer-operated service.

### Repository and package entry documents

- `README.md` must link prominently to `https://docs.test-apo.online/` and the
  human Quickstart, use the canonical safe local setup, install the CLI before
  invoking it, and replace Task Source sync with `apo task publish`.
- `packages/cli/README.md` must lead with:

  ```bash
  npm install -g @apo-ai/cli
  apo --version
  ```

  It may show `npx @apo-ai/cli ...` as the no-global-install alternative and a
  project dev-dependency as an advanced/CI option. Every shown form must
  actually expose the `apo` executable.
- `apps/docs/README.md` must describe the current branded public docs site and
  current source layout. Remove proof-of-concept and future-theming claims.

### Supporting public pages

Correct only the supporting pages that contradict the first-run path:

- `apps/docs/src/content/docs/guides/define-a-task.mdx`
  - replace `apo project source sync` with `apo task publish`;
  - show current publication output and then the one-shot run.
- `apps/docs/src/content/docs/guides/run-and-debug.mdx`
  - remove `apo batch create` and use a current user-reachable trigger;
  - keep `apo connect` only where dashboard/Schedule dispatch requires it.
- `apps/docs/src/content/docs/cli/index.md`
  - list only commands present in `apo --help`;
  - remove the retired Project Task Source and Batch-create entries.
- `apps/docs/src/content/docs/cli/batch.mdx`
  - document only current `batch list` and `batch show` behavior;
  - remove the `batch create` synopsis, examples, and fabricated output.
- `apps/docs/src/content/docs/self-hosting/topology.md`
  - render the current frontend/backend Control Plane plus an external
    source-owning machine;
  - replace retired executor services/volumes and expected service lists.
- `apps/docs/src/content/docs/self-hosting/configuration.md`
  - remove Bundled Executor configuration and troubleshooting;
  - describe persistence for the database and Artifact store that exist now;
  - point execution availability troubleshooting at `apo connect` and the
    Connected Executor status surface.
- `apps/docs/src/content/docs/reference/configuration.md`
  - remove retired Bundled Executor variables from the current configuration
    table.
- `docs/self-hosted-alpha.md`
  - mirror the current Source-Owned Execution topology because `README.md`
    links this file as the repository-local operator guide.
- `docs/architecture.md`
  - correct the stale one-paragraph self-host topology summary so it no longer
    contradicts the public guide.
- `docs/development.md`
  - replace retired Task Source CLI instructions with the current Task Catalog
    publication and source-owned execution workflow.

The implementation may touch another public page only when the regression
verifier identifies the same retired command/runtime claim. Do not turn this
into a general prose rewrite.

## Acceptance Tests (RED-FIRST)

### Unit tests

1. **Onboarding verifier rejects placeholders and retired commands**
   - Setup: Add a fixture/copy containing one of: `git clone <repo-url>`,
     `apo project source sync`, `apo project init-tasks`,
     `apo project sync-tasks`, or `apo batch create`.
   - Action: Run the onboarding documentation verifier.
   - Expected: Non-zero exit naming the offending file and phrase.

2. **Onboarding verifier rejects the retired server executor topology**
   - Setup: Add a fixture/copy containing `Bundled Executor`,
     `APO_BUNDLED_EXECUTOR_ENABLED`, `apo_executor_state`,
     `apo_executor_bootstrap`, or `task_source_cache` in a current-state
     onboarding/operator page.
   - Action: Run the verifier.
   - Expected: Non-zero exit naming the stale current-state claim. Specs, ADRs,
     migration history, and explicitly marked historical material are outside
     the verifier's scan roots.

3. **Quickstart contains the complete sequence in order**
   - Setup: Build the docs site.
   - Action: Inspect generated `quickstart/index.html` and `quickstart.md`.
   - Expected: repository clone precedes `self-host init`, which precedes
     `self-host up`, readiness, CLI installation, login, SDK installation,
     Task publication, one-shot Task run, and finally optional `apo connect`.

4. **Entry documents do not contain recruitment or hosted-service promises**
   - Setup: Scan `README.md`, the human Quickstart, and generated `start.md`.
   - Action: Search for the forbidden recruitment phrases defined in this
     spec and any claim that Apo provides a hosted Control Plane.
   - Expected: No matches. References to a team-operated shared Self-Hosted
     Installation and the public docs origin remain valid.

5. **CLI overview contains only live commands**
   - Setup: Capture the current top-level output of
     `node --experimental-strip-types packages/cli/src/main.ts --help`.
   - Action: Compare every documented command in the CLI overview's command
     tables with that output.
   - Expected: Every documented command is reachable; the retired commands are
     absent.

### Scene/integration tests

1. **Built human and agent entry points agree**
   - Setup: Run `pnpm --filter docs build`.
   - Action: Inspect the built human Quickstart and `/start.md` through the
     same verification command used by CI.
   - Expected: Both describe the same Local Profile, install the same public
     packages, and converge on `apo task publish` followed by one-shot
     `apo task run`. The docs publication verifier also remains green.

2. **Documented self-host initialization command is executable and safe**
   - Setup: Create a temporary env-file path outside the repository and ensure
     Docker Compose is available. Do not use or modify the developer's real
     `.env`.
   - Action: Run the documented `scripts/self-host init --profile local` with
     that env file, then run `scripts/self-host doctor` against it.
   - Expected: The file is mode `0600`, contains a non-placeholder
     `AUTH_SECRET`, selects the Local Profile, and `doctor` exits successfully.
     The test does not start or stop the development server.

3. **Rendered Local Profile has no server-owned Task runner**
   - Setup: Render `docker-compose.yml` with the temporary initialized env.
   - Action: Inspect services, volumes, and backend environment.
   - Expected: base services are `frontend` and `backend`; there is no
     `executor` service, executor bootstrap/state volume, Task source cache
     volume, or bundled-executor enablement variable.

## Integration Points (WIRING — mandatory, concrete)

### Documentation build wiring

- Create `apps/docs/scripts/verify-self-adoption.mjs` using Node built-ins.
- Add it to `apps/docs/package.json` so `pnpm --filter docs build` runs it after
  the normal Astro build and existing publication verification.
- The verifier must inspect both source entry files and generated artifacts
  where ordering/rendering matters. It must print actionable file-and-phrase
  failures rather than a generic assertion error.
- Add a root script such as `test:self-adoption-docs` that runs the focused
  verifier/contract without starting services.
- Add the focused check to `.github/workflows/ci.yml` beside the current docs
  build/publication checks.

### Public navigation wiring

- `README.md` links the live docs origin and `/quickstart/` in its opening link
  row.
- The existing Starlight sidebar continues to expose Quickstart under Getting
  Started. No new page or sidebar group is needed.
- The landing-page Copy Prompt continues to target the generated `/start.md`;
  this spec changes the setup instructions in that document, not the CTA.

### Test wiring

- Create a focused deployment/documentation contract under
  `tests/deployment/` following the shell-wrapper plus Node assertion pattern
  used by `tests/deployment/public-docs-contract.sh`.
- The contract must use `mktemp`, clean up on exit, and never read, print, or
  overwrite the repository `.env`.
- Register the contract in the root `package.json` script named above.

## Behavior

1. A visitor with no Apo server is never blocked by a server-URL decision. The
   docs take them through the Local Profile.
2. A visitor joining an existing team can skip server setup and set
   `APO_BACKEND_URL` to that team's own Self-Hosted Installation.
3. Starting the Control Plane does not imply Task execution capacity. The
   one-shot CLI runs locally; dashboard and scheduled Runs require
   `apo connect` in the source-owning environment.
4. Provider credentials are never requested by the Control Plane quickstart.
   They belong to the user's agent environment and are mentioned only when the
   real agent or judge requires them.
5. Every command on the first-run path is copyable and current. Placeholder
   URLs, retired commands, and fabricated service names fail CI.
6. Marketing and recruitment language never becomes a prerequisite for
   understanding or adopting the product.

## Data Flow

```text
docs visitor
  -> clones Apo
  -> scripts/self-host initializes Local Profile safely
  -> frontend + backend become ready on localhost
  -> visitor creates first User + Project
  -> published CLI authenticates to that Project
  -> application installs published SDK
  -> apo task publish sends bounded Task metadata (not source)
  -> apo task run executes the real Task on the application machine
  -> Control Plane stores verdict + Tests + Trace + Deliverables
  -> optional apo connect enables dashboard/Schedule dispatch
```

## Implementation Details

### Files to create

```text
apps/docs/scripts/verify-self-adoption.mjs
tests/deployment/self-adoption-docs-contract.sh
tests/deployment/self-adoption-docs-contract.mjs
```

### Files to modify

```text
README.md
  -> link live docs; use safe self-host helper; install CLI; use Task Catalog publication

packages/cli/README.md
  -> lead with global install and verified executable; keep alternatives secondary

apps/docs/README.md
  -> describe the current public branded site rather than the retired POC state

apps/docs/package.json
  -> run the self-adoption verifier as part of the docs build

package.json
  -> add the focused self-adoption docs contract command

.github/workflows/ci.yml
  -> run the focused contract in CI

apps/docs/src/content/docs/quickstart.mdx
apps/docs/src/pages/start.md.ts
  -> converge human and agent first-run paths on safe Local Profile setup

apps/docs/src/content/docs/guides/define-a-task.mdx
apps/docs/src/content/docs/guides/run-and-debug.mdx
apps/docs/src/content/docs/cli/index.md
apps/docs/src/content/docs/cli/batch.mdx
  -> replace removed commands and preserve current source-owned workflow

apps/docs/src/content/docs/self-hosting/topology.md
apps/docs/src/content/docs/self-hosting/configuration.md
apps/docs/src/content/docs/reference/configuration.md
docs/self-hosted-alpha.md
docs/architecture.md
docs/development.md
  -> remove retired Bundled Executor/Task Source claims and describe current Compose/runtime truth
```

### Existing patterns to follow

- Documentation craft and rendered review: `.agents/skills/docs-craft/SKILL.md`.
- Public artifact verification: `apps/docs/scripts/verify-publication.mjs`.
- Deployment contract wrapper: `tests/deployment/public-docs-contract.sh`.
- Current self-host behavior: `scripts/self-host` and `docker-compose.yml`.
- Current CLI surface: `packages/cli/src/main.ts` and each command's `--help`.
- Product beliefs and terminology: `PROJECT-BELIEFS.md` and `CONTEXT.md`.

## Quality Constraints

- Do not add dependencies.
- Do not change backend, dashboard, SDK, CLI, Compose, or self-host-helper
  behavior to make a documentation claim true. Document current behavior.
- Do not introduce a hosted Apo URL, signup funnel, waitlist, analytics, or
  maintainer-contact requirement.
- Do not add recruitment language anywhere in product documentation.
- Do not restore Bundled Executor, server-side repository sync, or removed CLI
  commands as compatibility paths.
- Do not duplicate the full Task/Adapter reference in Quickstart; show the
  minimum runnable shape and link to canonical guides.
- Every command must show representative output, and output must be checked
  against the current implementation rather than invented.
- Keep Quickstart a tutorial, Self-Hosting pages operator guides, Concept pages
  explanations, and CLI pages reference material.
- Use `npm` in the package-neutral public first-run commands. Package-specific
  pages may additionally show pnpm/yarn equivalents.
- Preserve the existing dark/monochrome docs presentation; this spec is not a
  visual redesign.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm --filter docs build`, and the new
  focused contract. Python typechecking is not required when no Python file is
  changed.

## Database Changes

None.

## API Contract

None. Existing authentication, Project, Task Catalog, Caller Execution,
Connected Executor, Run, Trace, and Deliverable APIs remain unchanged.

## Success Criteria

- [ ] A newcomer with no Apo server is given a complete local self-host path
      before any existing-server branch.
- [ ] `README.md`, Quickstart, and generated `start.md` agree on setup order and
      current commands.
- [ ] The CLI is installed before its first invocation in every entry path.
- [ ] Task Catalog publication uses `apo task publish`; no public current-state
      page advertises retired Task Source sync commands.
- [ ] Public current-state docs describe Source-Owned Execution and no Bundled
      Executor service/volume.
- [ ] CLI overview/reference pages list only commands reachable from the
      current CLI.
- [ ] Quickstart renders command output and reaches a one-shot Task verdict
      before introducing `apo connect`.
- [ ] No recruitment, waitlist, hosted-service, or maintainer-help requirement
      is added.
- [ ] The focused verifier fails on reintroducing placeholder URLs, retired
      commands, or retired executor topology.
- [ ] `pnpm --filter docs build` passes and verifies the built human and
      agent-readable entry points.
- [ ] The focused self-adoption documentation contract passes in CI.
- [ ] `pnpm lint` and `pnpm typecheck` pass.

## Non-goals

- Providing or operating an Apo cloud/SaaS service.
- Making the maintainer's private test installation public.
- Recruiting alpha users or adding marketing/lead-capture copy.
- Creating a new `apo server`, installer, bootstrap API, or Compose topology.
- Publishing a standalone example repository or template generator.
- Adding support for another language, agent framework, model provider, or
  package manager.
- Redesigning the docs site or rewriting unrelated concept/reference pages.
- Declaring Apo generally available or production-ready beyond the existing
  single-node alpha contract.

## Log

- 2026-08-07: Spec created after an outside-in audit of the public first-run
  path, current CLI help, source-owned Compose topology, and published docs.
