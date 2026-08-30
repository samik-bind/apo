"use client";

import { useParams } from "next/navigation";

import { DEFAULT_PROJECT, DEMO_PROJECT } from "./project-ids";
export { DEFAULT_PROJECT, DEMO_PROJECT };

/** Get the current project ID from the URL params (client-side). */
export function useProjectId(): string {
  const params = useParams<{ projectId?: string }>();
  return params?.projectId ?? DEFAULT_PROJECT;
}

/** Check if the current project is the demo workspace. */
export function useIsDemo(): boolean {
  return useProjectId() === DEMO_PROJECT;
}
