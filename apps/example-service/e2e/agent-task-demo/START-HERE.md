# apo canonical example — START HERE

This is apo's single canonical first-Task example. It wires a real Vercel AI
SDK agent through an Apo Adapter to a `data-extraction` Task that extracts
structured data from an invoice.

## The four concepts

| Concept | Source file |
|---|---|
| **Real agent** | [`app/lib/agent/service.ts`](../../app/lib/agent/service.ts) — the Vercel AI SDK agent (`handleChat`) |
| **Apo Adapter** | [`ai-sdk-adapter.ts`](../ai-sdk-adapter.ts) — thin bridge calling `handleChat()` |
| **First Task** | [`tasks/ai-sdk-agent/data-extraction/data-extraction.eval.ts`](tasks/ai-sdk-agent/data-extraction/data-extraction.eval.ts) |
| **Task inputs** | [`tasks/ai-sdk-agent/data-extraction/files/`](tasks/ai-sdk-agent/data-extraction/files/) — `invoice.txt` + `instructions.md` |

## Prerequisites

- An Apo Control Plane running locally (see the [Quickstart](https://docs.test-apo.online/quickstart/)).
- `OPENROUTER_API_KEY` set in this environment (the real agent calls a model).
- `@apo-ai/cli` installed (`npm install -g @apo-ai/cli`).
- `@apo-ai/sdk` installed in this project (`npm install @apo-ai/sdk`).

## Run it

```bash
export OPENROUTER_API_KEY=...

# Publish the Task catalog to your Apo project.
apo task publish --dir ./tasks/ai-sdk-agent

# Run the Task locally — the real agent calls the model.
apo task run data-extraction --dir ./tasks/ai-sdk-agent

# Inspect the verdict and trace.
apo runs show
apo traces show <trace-id>
```

## What happens

1. `apo task publish` sends bounded Task metadata (not source) to the Control Plane.
2. `apo task run` executes the real agent on this machine via the Vercel AI SDK.
3. The Adapter drives `handleChat()`, which calls the model with tools (`list_files`, `read_file`, `extract_entities`).
4. After the turn loop, `collectDeliverables` shapes the session into structured outputs.
5. Tests assert that the agent called the right tools and the deliverables are well-formed.
6. The Control Plane records the verdict (pass/fail), checks, trace, and deliverables.

## Adapt this to your agent

Replace `app/lib/agent/service.ts` with your real agent, write an Adapter that
calls it through `sendUserTurn`, and define a Task that asserts what "good"
means. See the [Adapter API reference](https://docs.test-apo.online/reference/adapter/)
for the full lifecycle.

## Maintainer video rehearsal

If you are preparing the first Apo product demo (a coding-agent repair loop),
see the separate [`e2e/video-rehearsals/agent-repair-loop/README.md`](../video-rehearsals/agent-repair-loop/README.md).
It is a disposable rehearsal scenario with a deliberately incomplete starting
implementation, not part of this canonical newcomer flow.
