"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  Cpu,
  Timer,
} from "lucide-react";
import { ExpandableJson } from "@/components/ExpandableJson";
import { Markdown } from "@/components/trace-detail/Markdown";
import type { JudgeMetadata } from "@/lib/agent-task-api";
import { formatTokenBreakdown } from "@/lib/format";

function formatLatency(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(tokens?: { input: number; output: number }): string | null {
  if (!tokens) return null;
  return formatTokenBreakdown(tokens.input, tokens.output);
}

//─ Judge details (LLM evaluator metadata)──────────────────────────────

export function JudgeStrip({ judge }: { judge: JudgeMetadata }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [showResponse, setShowResponse] = useState(false);

  // The judge LLM responds with a JSON object {pass, reasoning}. Parse it so
  // we can render with ExpandableJson's tree view instead of a wall of text.
  let parsedResponse: unknown = null;
  let responseIsJson = false;
  if (judge.response) {
    try {
      parsedResponse = JSON.parse(judge.response);
      responseIsJson = true;
    } catch {
      const match = judge.response.match(/(\{|\[)[\s\S]*(\}|\])/);
      if (match) {
        try {
          parsedResponse = JSON.parse(match[0]);
          responseIsJson = true;
        } catch {
          // not valid JSON — fall through to text rendering
        }
      }
    }
  }

  const hasPrompt = Boolean(judge.prompt?.system || judge.prompt?.user);
  const hasResponse = Boolean(judge.response);
  const formattedTokens = judge.tokens ? formatTokens(judge.tokens) : null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {judge.model && (
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="h-3 w-3" />
            <span className="font-mono">{judge.model}</span>
          </span>
        )}
        {judge.latency_ms != null && (
          <span className="inline-flex items-center gap-1.5">
            <Timer className="h-3 w-3" />
            <span>{formatLatency(judge.latency_ms)}</span>
          </span>
        )}
        {formattedTokens && (
          <span className="inline-flex items-center gap-1.5">
            <Coins className="h-3 w-3" />
            <span>{formattedTokens}</span>
          </span>
        )}
        {judge.temperature != null && (
          <span>temp <span className="text-foreground">{judge.temperature}</span></span>
        )}
      </div>

      {(hasPrompt || hasResponse) && (
        <div className="flex items-center gap-2">
          {hasPrompt && (
            <button
              type="button"
              onClick={() => setShowPrompt(!showPrompt)}
              className="inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPrompt ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Judge prompt
            </button>
          )}
          {hasResponse && (
            <button
              type="button"
              onClick={() => setShowResponse(!showResponse)}
              className="inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {showResponse ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Raw response
            </button>
          )}
        </div>
      )}

      {showPrompt && hasPrompt && (
        <div className="space-y-2 border border-border bg-background/40 p-2">
          {judge.prompt?.system && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                System
              </p>
              <Markdown className="text-[12px]">{judge.prompt.system}</Markdown>
            </div>
          )}
          {judge.prompt?.user && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                User
              </p>
              <Markdown className="text-[12px]">{judge.prompt.user}</Markdown>
            </div>
          )}
        </div>
      )}

      {showResponse && hasResponse && (
        responseIsJson && parsedResponse !== null ? (
          <ExpandableJson
            data={parsedResponse}
            className="!rounded-none !border-0 !shadow-none"
          />
        ) : (
          <Markdown className="border border-border bg-background/40 p-2 text-[12px]">
            {judge.response ?? ""}
          </Markdown>
        )
      )}
    </div>
  );
}
