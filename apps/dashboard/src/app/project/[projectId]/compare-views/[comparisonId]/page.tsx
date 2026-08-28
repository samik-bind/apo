import { Suspense } from "react";
import { notFound } from "next/navigation";
import { headers } from "next/headers";

import {
  getTaskViewComparisonOverview,
} from "@/lib/agent-task-view-api";
import { isNotFoundStatus } from "@/lib/api-error";
import { CompareViewsClient } from "./compare-views-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Compare views" };

const CRAWLER_UA = /(?:Slackbot|Twitterbot|facebookexternalhit|LinkedInBot|TelegramBot|WhatsApp|Discordbot|Googlebot|Bingbot|Bytespider|Applebot)/i;

export default async function CompareViewsPage({
  params,
}: {
  params: Promise<{ projectId: string; comparisonId: string }>;
}) {
  const [{ projectId, comparisonId }, headerList] = await Promise.all([
    params,
    headers(),
  ]);
  const isCrawler = CRAWLER_UA.test(headerList.get("user-agent") ?? "");

  // Fetch only the lightweight overview (snapshot + scalar
  // summaries). Check Reports, Task Definition bodies, transcripts, and
  // Deliverable JSON are loaded progressively when a task is expanded.
  let overview: Awaited<ReturnType<typeof getTaskViewComparisonOverview>> | null = null;
  let loadError: unknown = null;
  try {
    overview = await getTaskViewComparisonOverview(projectId, comparisonId);
  } catch (error) {
    loadError = error;
  }

  // notFound() throws a control-flow error, so it must be called outside the
  // try/catch — a catch block would swallow it and the 404 would silently
  // fail. Real 404 (comparison doesn't exist) → show 404 for everyone.
  // Auth failures (401/403) → crawlers get a 200 so OG meta tags work;
  // real users were already redirected to /login by the project layout.
  if (loadError !== null && (isNotFoundStatus(loadError) || !isCrawler)) {
    notFound();
  }

  if (!overview) {
    // Crawler with no auth: render a minimal shell so the page returns 200.
    // The og:image meta tags come from the route segment's opengraph-image.
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <p>Sign in to view this comparison.</p>
      </div>
    );
  }

  const { snapshot } = overview;
  const runMap = new Map(overview.runs.map((run) => [run.id, run]));
  const leftRuns = snapshot.resolved
    .map((cell) => (cell.a_run_id ? runMap.get(cell.a_run_id) : undefined))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const rightRuns = snapshot.resolved
    .map((cell) => (cell.b_run_id ? runMap.get(cell.b_run_id) : undefined))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const comparisonStates = new Map(
    snapshot.resolved.map((cell) => [cell.task_id, cell.state] as const),
  );

  // Suspense: CompareViewsClient reads ?expand via useUrlParam/useSearchParams,
  // which needs a boundary above it so the page can still stream the shell.
  return (
    <Suspense fallback={null}>
      <CompareViewsClient
        projectId={projectId}
        comparisonId={comparisonId}
        snapshot={snapshot}
        tasks={[]}
        leftRuns={leftRuns}
        rightRuns={rightRuns}
        stateByTask={comparisonStates}
      />
    </Suspense>
  );
}
