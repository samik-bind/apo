"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Code2,
  ExternalLink,
  FileText,
  MessageSquare,
} from "lucide-react";
import { useUrlParam } from "@/hooks/use-url-state";
import { TraceHomeLink } from "@/components/trace-detail";
import { ConversationTranscript } from "@/components/agent-task-execution/conversation-transcript";
import { DeliverablesPanel } from "@/components/agent-task-execution/deliverables-panel";
import type { DeliverableSummary } from "@/lib/agent-task-deliverables-api";
import { readTaskFile, readTaskDefinitionSource, type TaskFileContentResponse, type TaskDefinitionRevisionSummary } from "@/lib/agent-task-api";
import type { CheckResult } from "@/lib/agent-task-api";
import { extractCheckBlock } from "@/lib/extract-check-block";
import {
  buildSourceCandidates,
  checkAnchorLine,
  shouldAcceptSource,
} from "@/lib/check-source-candidates";
import { cn } from "@/lib/utils";
import { ChecksList } from "./checks-list";
import { DeliverablesView } from "./deliverables-view";
import { useLazyConversation } from "./use-lazy-conversation";
import { Panel } from "./panel";

type Tab = "checks" | "transcript" | "deliverables";

// ── Main body ────────────────────────────────────────────────────────────

export function TaskRunDetailBody({
  checks,
  deliverables,
  deliverableItems,
  traceRunId,
  projectId,
  commitSha,
  taskId,
  sourceType,
  taskDefinition,
  taskRunId,
}: {
  checks: CheckResult[];
  deliverables: Record<string, unknown> | null;
  deliverableItems: DeliverableSummary[];
  traceRunId: string | null;
  projectId?: string | null;
  commitSha?: string | null;
  taskId: string;
  sourceType?: string | null;
  taskDefinition?: TaskDefinitionRevisionSummary | null;
  taskRunId?: string | null;
}) {
  // Active tab lives in the URL (?tab=) so a shared link lands the reader on
  // the same view (checks / transcript / deliverables).
  const [tabParam, setTabParam] = useUrlParam("tab");
  const tab: Tab = tabParam === "transcript" || tabParam === "deliverables" ? tabParam : "checks";

  const conversationState = useLazyConversation(
    traceRunId,
    projectId,
    tab === "transcript",
  );

  const recordedSourceFile = checks.find((check) => check.source_file)?.source_file;
  const checkIds = checks.map((check) => check.id).join("\u0000");

  // The check-source fetch is fully described by this key (pinned definition
  // path, commit, checks, recorded source, …). Results are tagged with it so
  // the render can hide stale data on the first frame after the request
  // changes, instead of flashing it until an effect resets the state.
  const definitionPath = taskDefinition?.files[0]?.path ?? null;
  const sourceRequestKey = [
    taskId,
    taskRunId ?? null,
    definitionPath,
    checkIds,
    commitSha ?? null,
    projectId ?? null,
    recordedSourceFile ?? null,
    sourceType,
  ].join("\u0001");
  const [sourceState, setSourceState] = useState<{
    key: string;
    data: TaskFileContentResponse | null;
    error: string | null;
  }>({ key: "", data: null, error: null });

  const loadCheckSource = useCallback(
    async (
      candidates: string[],
      signal: AbortSignal,
    ): Promise<TaskFileContentResponse> => {
      if (!projectId) {
        throw new Error("Project context required to load check source");
      }
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          const source = await readTaskFile(
            taskId,
            candidate,
            projectId,
            commitSha ?? undefined,
            signal,
          );
          const containsKnownCheck = checks.some((check) =>
            extractCheckBlock(source.content, { id: check.id, anchorLine: checkAnchorLine(check) }) !== null
          );
          if (
            shouldAcceptSource({
              candidate,
              recordedSourceFile,
              containsKnownCheck,
              isLastCandidate: candidate === candidates[candidates.length - 1],
            })
          ) {
            return source;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error;
        }
      }
      if (lastError instanceof Error) throw lastError;
      throw new Error("Could not load check source — no .eval.ts, task.ts, or checks.ts found");
    },
    [taskId, projectId, commitSha, checks, recordedSourceFile],
  );

  useEffect(() => {
    if (checks.length === 0) return;
    // Already holding a successful result for this exact request.
    if (sourceState.key === sourceRequestKey && sourceState.data !== null) return;
    // SPEC-169: when a Task Definition is pinned, load source through the
    // Run-bound endpoint instead of the retired project-source resolver.
    if (taskDefinition && taskRunId && taskDefinition.files[0]) {
      const controller = new AbortController();
      readTaskDefinitionSource(taskRunId, taskDefinition.files[0].path, controller.signal)
        .then((source) => {
          if (!controller.signal.aborted) {
            setSourceState({ key: sourceRequestKey, data: source, error: null });
          }
        })
        .catch((err) => {
          if (!controller.signal.aborted) {
            setSourceState({ key: sourceRequestKey, data: null, error: err instanceof Error ? err.message : "Failed to load definition source" });
          }
        });
      return () => controller.abort();
    }
    // No definition: fall back to the legacy project-source path (or skip
    // for published catalogs where source is metadata-only).
    if (!projectId || sourceType === "published") return;
    const controller = new AbortController();

    void loadCheckSource(
      buildSourceCandidates(recordedSourceFile, taskId),
      controller.signal,
    )
      .then((data: TaskFileContentResponse) => {
        if (controller.signal.aborted) return;
        setSourceState({ key: sourceRequestKey, data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSourceState({
          key: sourceRequestKey,
          data: null,
          error: error instanceof Error
            ? error.message
            : "Check source could not be loaded",
        });
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    checkIds,
    checks.length,
    commitSha,
    projectId,
    recordedSourceFile,
    sourceType,
    taskId,
  ]);

  // Only expose a result while it belongs to the current request key.
  const checksSource = sourceState.key === sourceRequestKey ? sourceState.data : null;

  const checksPassed = checks.filter((check) => check.pass === true).length;
  const failedCount = checks.length - checksPassed;

  const tabs: Array<{
    id: Tab | "trace";
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }> = [
    { id: "checks", label: "Checks", icon: Code2, count: checks.length },
    { id: "transcript", label: "Conversation History", icon: MessageSquare },
    { id: "deliverables", label: "Deliverables", icon: FileText },
  ];

  if (traceRunId) {
    tabs.push({ id: "trace", label: "Trace home", icon: ExternalLink });
  }

  return (
    <>
      <div className="flex items-center gap-1 border-t border-border px-4">
        {tabs.map((tabItem) => {
          const isTrace = tabItem.id === "trace";
          const isActive = !isTrace && tab === tabItem.id;

          if (isTrace) {
            return (
              <TraceHomeLink
                key={tabItem.id}
                traceId={traceRunId!}
                label={tabItem.label}
                appearance="tab"
              />
            );
          }

          return (
            <button
              type="button"
              key={tabItem.id}
              onClick={() => setTabParam(tabItem.id as Tab)}
              className={cn(
                "relative inline-flex h-9 items-center gap-1.5 px-3 text-[13px] font-medium transition-colors",
                isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <tabItem.icon className="h-3.5 w-3.5" />
              {tabItem.label}
              {typeof tabItem.count === "number" && (
                <span
                  className={cn(
                    "px-1 font-mono text-[10px] tabular-nums",
                    isActive ? "bg-foreground/10 text-foreground" : "bg-card text-muted-foreground",
                  )}
                >
                  {tabItem.count}
                </span>
              )}
              {isActive && <span className="absolute inset-x-2 -bottom-px h-px bg-foreground" />}
            </button>
          );
        })}
      </div>

      <div className="space-y-4 px-6 py-5">
        {tab === "checks" && (
          <>
            {checks.length > 0 && (
              <div className="flex items-center justify-between text-[12px]">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">{checksPassed}</span>/{checks.length} passed
                  </span>
                  {failedCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                      {failedCount} failed
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground/60">Click to expand</span>
              </div>
            )}

            {checksSource && (
              <p className="text-[11px] text-muted-foreground/70">
                Expand a code check to see its source with the failing line marked.
              </p>
            )}
            {!checksSource && checks.length > 0 && sourceType === "published" && (
              <p className="text-[11px] text-muted-foreground/70">
                Check source remains on the machine that executed this task — published task catalogs carry metadata only.
              </p>
            )}

            {checks.length > 0 && (
              <Panel padded={false}>
                <ChecksList checks={checks} checksSource={checksSource} />
              </Panel>
            )}

            {checks.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">No checks recorded</p>
            )}
          </>
        )}

        {tab === "transcript" && (
          conversationState.status === "ready" ? (
            <ConversationTranscript
              conversation={conversationState.messages}
              traceRunId={traceRunId}
            />
          ) : conversationState.status === "error" ? (
            <p className="py-4 text-center text-sm text-destructive">
              Failed to load transcript: {conversationState.message}
            </p>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Loading transcript…
            </p>
          )
        )}

        {tab === "deliverables" && (
          deliverableItems.length > 0 ? (
            <DeliverablesPanel items={deliverableItems} />
          ) : deliverables ? (
            <DeliverablesView deliverables={deliverables} />
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">No deliverables recorded</p>
          )
        )}
      </div>
    </>
  );
}
