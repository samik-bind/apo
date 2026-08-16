import { apiClient } from "./api-client";
import { backendFetch } from "./backend-fetch";

export interface HostedAccessInvitationSummary {
  id: string;
  email: string;
  delivery_method: "email" | "link_only";
  expires_at: string;
  created_at: string;
  invited_by_user_id: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  accepted_project_id: string | null;
  revoked_at: string | null;
}

export interface CreateHostedAccessInvitationResponse {
  invitation: HostedAccessInvitationSummary;
  /** Present only when the administrator must share the link out-of-band. */
  invite_url: string | null;
  delivery_status: "sent" | "link_only";
}

export interface HostedAccessPreview {
  valid: boolean;
  reason: "invalid" | "expired" | "revoked" | "accepted" | null;
  email: string | null;
  requires_login: boolean;
  requires_account_creation: boolean;
}

export interface AcceptHostedAccessCreateAccountRequest {
  token: string;
  name: string;
  password: string;
  project_name: string;
}

const NO_CACHE = { cache: "no-store" } as const;

// Administrator endpoints ride the authenticated browser session —
// never an ADMIN_API_KEY in URLs or client code.
export const listHostedAccessInvitations = (): Promise<
  HostedAccessInvitationSummary[]
> => apiClient("/v1/admin/hosted-access-invitations", NO_CACHE);

export const createHostedAccessInvitation = (
  email: string,
): Promise<CreateHostedAccessInvitationResponse> =>
  apiClient("/v1/admin/hosted-access-invitations", {
    ...NO_CACHE,
    method: "POST",
    body: { email },
  });

export const resendHostedAccessInvitation = (
  invitationId: string,
): Promise<CreateHostedAccessInvitationResponse> =>
  apiClient(
    `/v1/admin/hosted-access-invitations/${invitationId}/resend`,
    { ...NO_CACHE, method: "POST" },
  );

export const revokeHostedAccessInvitation = (
  invitationId: string,
): Promise<void> =>
  apiClient(`/v1/admin/hosted-access-invitations/${invitationId}`, {
    ...NO_CACHE,
    method: "DELETE",
  });

export const acceptHostedAccessExistingAccount = (
  token: string,
  projectName: string,
): Promise<{ status: string; project_id: string }> =>
  apiClient("/auth/hosted-access/accept/existing-account", {
    ...NO_CACHE,
    method: "POST",
    body: { token, project_name: projectName },
  });

// Public pre-admission endpoints run before any session cookie exists.
// backendFetch routes browser calls through /backend-proxy and simply
// forwards an absent session cookie.
export async function previewHostedAccessToken(
  token: string,
  signal?: AbortSignal,
): Promise<HostedAccessPreview> {
  const res = await backendFetch(
    `/auth/hosted-access/preview?token=${encodeURIComponent(token)}`,
    { cache: "no-store", signal },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(
      typeof body?.detail === "string" && body.detail.trim()
        ? body.detail
        : `Failed to preview invitation: ${res.status}`,
    );
  }
  return res.json();
}

export async function acceptHostedAccessCreateAccount(
  body: AcceptHostedAccessCreateAccountRequest,
): Promise<{ status: string; project_id: string }> {
  const res = await backendFetch("/auth/hosted-access/accept/create-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const respBody = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(
      typeof respBody?.detail === "string" && respBody.detail.trim()
        ? respBody.detail
        : `Failed to accept invitation: ${res.status}`,
    );
  }
  return res.json();
}
