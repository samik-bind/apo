import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";

import { DashboardShell } from "@/components/dashboard-shell";
import { ProjectAccessDenied } from "@/components/project-access-denied";
import { isForbidden, isNotFoundStatus, isUnauthorized } from "@/lib/api-error";
import { getProject } from "@/lib/projects-api";

const CRAWLER_UA = /(?:Slackbot|Twitterbot|facebookexternalhit|LinkedInBot|TelegramBot|WhatsApp|Discordbot|Googlebot|Bingbot|Bytespider|Applebot)/i;

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const [{ projectId }, headerList] = await Promise.all([params, headers()]);

  // Social media crawlers can't authenticate. Let them through so the
  // page's og:image meta tags appear in the HTML; app-level auth still
  // protects actual data — the overview fetch fails gracefully.
  if (CRAWLER_UA.test(headerList.get("user-agent") ?? "")) {
    return <DashboardShell projectId={projectId}>{children}</DashboardShell>;
  }

  // Centralized access guard: every project sub-route inherits this check.
  // The backend distinguishes 401 (not authenticated), 403 (not a member),
  // and 404 (project missing); we translate each into the matching
  // full-page state instead of letting individual pages re-derive it.
  let accessError: unknown = null;
  try {
    await getProject(projectId);
  } catch (error) {
    accessError = error;
  }

  // redirect()/notFound() throw control-flow errors, so they must be called
  // outside the try/catch — a catch block would swallow them and the
  // redirect/404 would silently fail.
  if (accessError !== null) {
    if (isUnauthorized(accessError)) {
      // Remember where the visitor was heading so login can return them
      // there (SPEC-181) instead of the generic home redirect.
      redirect(
        `/login?callbackUrl=${encodeURIComponent(`/project/${projectId}`)}`,
      );
    }
    if (isNotFoundStatus(accessError)) {
      notFound();
    }
    if (isForbidden(accessError)) {
      return <ProjectAccessDenied projectId={projectId} />;
    }
    throw accessError;
  }

  return <DashboardShell projectId={projectId}>{children}</DashboardShell>;
}
