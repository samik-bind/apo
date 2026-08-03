/**
 * Resolve the source of a check for the code viewers.
 *
 * Two resolvers exist, and the order matters:
 *
 * 1. **The pinned Task Definition (SPEC-169)** — the exact `*.eval.ts` text
 *    captured at run time and stored server-side, addressed per-run. This is
 *    authoritative: it is the source that produced the stored Check evidence,
 *    and it works regardless of where the Task executed.
 * 2. **The task-files resolver** — retired, kept as a legacy fallback for runs
 *    with no pinned definition. It discovers Tasks on the *backend's own
 *    filesystem*, so it can only ever succeed when the backend shares a
 *    filesystem with the Task tree (a local backend). For a Task executing on a
 *    developer machine and recording to a hosted backend it always 404s.
 *
 * The compare view previously used only (2), so every check in a comparison of
 * developer-executed runs rendered "Task not found" — while the definition sat
 * pinned to both runs. Extracted here as a pure, dependency-injected function
 * so the precedence is testable: the vitest JSX transform in this repo cannot
 * parse `.tsx` imports, so logic living inside a component is untestable.
 */

import { buildSourceCandidates, shouldAcceptSource } from "./check-source-candidates";

export interface CheckSource {
  content: string;
  language?: string | null;
}

/** A run and the definition file path pinned to it. */
export interface DefinitionRef {
  runId: string;
  filePath: string;
}

export interface LoadCheckSourceDeps {
  /** SPEC-169 run-bound read of the pinned Task Definition source. */
  readDefinitionSource: (runId: string, filePath: string) => Promise<CheckSource>;
  /** Legacy filesystem-backed read; `commitSha` pins a published revision. */
  readTaskFile: (taskId: string, candidate: string, commitSha?: string) => Promise<CheckSource>;
}

export interface LoadCheckSourceInput {
  taskId: string;
  /** The authoritative `source_file` recorded on the check result, if any. */
  recordedSourceFile: string | undefined;
  commitSha: string | null;
  /**
   * Pinned definitions to try, in order. A comparison passes both sides; the
   * two runs of one task normally pin the same revision, so either resolves.
   */
  definitionRefs: DefinitionRef[];
  /** Whether loaded text contains a check block the caller recognizes. */
  containsKnownCheck: (content: string) => boolean;
  deps: LoadCheckSourceDeps;
}

export async function loadCheckSource(input: LoadCheckSourceInput): Promise<CheckSource> {
  let lastError: unknown;

  for (const ref of input.definitionRefs) {
    if (!ref.runId || !ref.filePath) continue;
    try {
      return await input.deps.readDefinitionSource(ref.runId, ref.filePath);
    } catch (error) {
      lastError = error;
    }
  }

  const candidates = buildSourceCandidates(input.recordedSourceFile, input.taskId);
  for (const candidate of candidates) {
    try {
      let source: CheckSource;
      try {
        source = await input.deps.readTaskFile(input.taskId, candidate, input.commitSha ?? undefined);
      } catch (error) {
        // A stale or unpublished revision must not strand the viewer when the
        // unpinned read would succeed.
        if (!input.commitSha) throw error;
        source = await input.deps.readTaskFile(input.taskId, candidate);
      }
      if (
        shouldAcceptSource({
          candidate,
          recordedSourceFile: input.recordedSourceFile,
          containsKnownCheck: input.containsKnownCheck(source.content),
          isLastCandidate: candidate === candidates[candidates.length - 1],
        })
      ) {
        return source;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Could not load check source — no pinned Task Definition and no readable task file");
}
