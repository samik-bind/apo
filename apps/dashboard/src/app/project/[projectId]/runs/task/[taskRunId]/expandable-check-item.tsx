"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useUrlParam } from "@/hooks/use-url-state";
import type { CheckAssertionResult, CheckResult, TaskFileContentResponse } from "@/lib/agent-task-api";
import { buildCheckDiagnostics } from "@/lib/check-diagnostics";
import { checkAnchorLine } from "@/lib/check-source-candidates";
import { extractCheckBlock } from "@/lib/extract-check-block";
import { locateAssertionsInBlock } from "@/lib/locate-assertion";
import { buildAssertionParam, parseOwnAssertionId } from "@/lib/assertion-select";
import { cn } from "@/lib/utils";
import { AssertionDrawer } from "./assertion-drawer";
import { JudgeStrip } from "./judge-strip";

// CodeMirror is heavy — load it only when a code check is expanded.
const CodeViewer = dynamic(
  () => import("@/components/CodeViewer").then((m) => m.CodeViewer),
  { ssr: false, loading: () => null },
);

export function ExpandableCheckItem({
  item,
  index,
  checksSource,
}: {
  item: CheckResult;
  index: number;
  checksSource?: TaskFileContentResponse | null;
}) {
  const passed = item.pass === true;
  const id = String(item.id ?? `Check ${index + 1}`);
  // Which checks are expanded is bulk, ephemeral state — keep it local rather
  // than bloating the URL. (The focused assertion drawer is the URL-synced bit.)
  const [expanded, setExpanded] = useState(false);
  const reasoning = typeof item.reasoning === "string" ? item.reasoning : "";
  const judgeAssertion = item.assertions?.find((a) => a.judge);
  const judgeMeta = judgeAssertion?.judge ?? item.judge;

  const checkBlock =
    checksSource
      ? extractCheckBlock(checksSource.content, {
          id: item.id,
          anchorLine: checkAnchorLine(item),
        })
      : null;
  const diagnostics = checkBlock
    ? buildCheckDiagnostics(item, checkBlock.startLine, checkBlock.endLine, checkBlock.code)
    : [];

  // Show all assertions — both passing and failing — so users can see the
  // actual values (e.g. "received: 6 tool calls" when the limit was 40).
  const visibleAssertions = item.assertions ?? [];

  const lineToAssertion = (() => {
    if (!checkBlock) return new Map<number, CheckAssertionResult>();
    const locatedLines = locateAssertionsInBlock(
      checkBlock.code,
      visibleAssertions.map((a) => ({ id: a.id })),
    );
    const map = new Map<number, CheckAssertionResult>();
    visibleAssertions.forEach((a, i) => {
      let line = locatedLines[i];
      if (line === undefined && a.location?.line) {
        line = a.location.line - checkBlock.startLine + 1;
      }
      if (line !== undefined && line >= 1) {
        map.set(line, a);
      }
    });
    return map;
  })();

  // Which line's assertion drawer is open, if any. The selection is encoded in
  // the URL as ?assertion=<checkId>::<assertionId> — namespaced by check id so
  // that opening a drawer in one check never bleeds into another. (Assertion
  // ids alone aren't unique across checks: every `t.judge` call defaults to
  // id "judge", so a bare ?assertion=judge would match every judge check.)
  const [assertionParam, setAssertionParam] = useUrlParam("assertion");

  // Does the URL point at an assertion in THIS check? Only the check whose id
  // matches the param's namespace prefix opens its drawer.
  const ownAssertionId = parseOwnAssertionId(assertionParam, id);

  // A shared link points at a specific assertion. If it lives in this check,
  // auto-expand the row so the drawer is visible without an extra click.
  // Done during render (prev-prop comparison) to avoid a stale-state flash.
  const [prevOwnAssertionId, setPrevOwnAssertionId] = useState(ownAssertionId);
  if (ownAssertionId !== prevOwnAssertionId) {
    setPrevOwnAssertionId(ownAssertionId);
    if (ownAssertionId && item.assertions?.some((a) => a.id === ownAssertionId)) {
      setExpanded(true);
    }
  }

  const selectedLine = (() => {
    if (!ownAssertionId || !checkBlock) return null;
    for (const [line, assertion] of lineToAssertion) {
      if (assertion.id === ownAssertionId) return line;
    }
    return null;
  })();
  const selectedAssertion = selectedLine !== null ? lineToAssertion.get(selectedLine) : undefined;
  const setSelectedLine = (line: number | null) => {
    const a = line !== null ? lineToAssertion.get(line) : undefined;
    setAssertionParam(buildAssertionParam(id, a?.id));
  };

  // Escape closes the drawer, matching the TracePanel pattern.
  useEffect(() => {
    if (!selectedAssertion) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAssertionParam(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedAssertion, setAssertionParam]);

  return (
    <div
      className={cn(
        "border-b border-border last:border-b-0 transition-colors",
        expanded ? "bg-card/30" : "hover:bg-card/20",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
            passed ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
          )}
        >
          {passed ? "✓" : "✗"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "font-mono text-[13px]",
                passed ? "text-foreground" : "text-destructive",
                expanded && "font-medium",
              )}
            >
              {id}
            </span>
            {!passed && !expanded && reasoning && (
              <span className="truncate text-[11px] text-muted-foreground">
                {reasoning.split("\n")[0]}
              </span>
            )}
          </div>
        </div>
        <span
          className="shrink-0 text-muted-foreground/60 transition-transform"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <div className="max-w-[860px] space-y-3">
            {checkBlock ? (
              <>
                <div className="overflow-hidden border border-border">
                  <CodeViewer
                    code={checkBlock.code}
                    language={checksSource?.language ?? "typescript"}
                    diagnostics={diagnostics}
                    onDiagnosticClick={(line) => {
                      setSelectedLine(selectedLine === line ? null : line);
                    }}
                  />
                  {selectedAssertion && (
                    <>
                      <button
                        type="button"
                        className="fixed inset-0 z-40 cursor-default"
                        aria-label="Close assertion drawer"
                        onClick={() => setSelectedLine(null)}
                      />
                      <div className="fixed inset-y-0 right-0 top-12 z-50 flex w-[480px] max-w-[90vw] flex-col border-l border-border bg-card shadow-2xl">
                        <AssertionDrawer assertion={selectedAssertion} onClose={() => setSelectedLine(null)} />
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                {reasoning && (
                  <p
                    className={cn(
                      "whitespace-pre-wrap text-[13px] leading-relaxed",
                      passed ? "text-foreground" : "text-destructive",
                    )}
                  >
                    {reasoning}
                  </p>
                )}
                {judgeMeta && <JudgeStrip judge={judgeMeta} />}
                {!reasoning && !judgeMeta && (
                  <p className="text-[12px] text-muted-foreground">No additional details</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
