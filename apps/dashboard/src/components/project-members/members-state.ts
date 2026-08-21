import type { ProjectMemberSummary } from "@/lib/project-members-api"
import type {
  CreateProjectInvitationResponse,
  ProjectInvitationSummary,
} from "@/lib/project-invitations-api"
import type { Project, ProjectPermissionSummary } from "@/lib/projects-api"

// ----------------------------------------------------------------------------
// Fetch-data reducer for ProjectMembersSection.
//
// Consolidates the related server data slices (projects list, and the
// per-project members/invitations/permissions fetch) into one reducer. The
// dialog/confirmation UI state below stays as independent useStates because
// those are unrelated to data fetching.
// ----------------------------------------------------------------------------

export interface FetchState {
  projects: Project[]
  projectsLoading: boolean
  permissions: ProjectPermissionSummary | null
  members: ProjectMemberSummary[]
  invitations: ProjectInvitationSummary[]
  loading: boolean
  loadError: string | null
}

type FetchAction =
  | { type: "PROJECTS_LOADED"; projects: Project[] }
  | { type: "FETCH_START" }
  | {
      type: "FETCH_LOADED"
      permissions: ProjectPermissionSummary | null
      members: ProjectMemberSummary[]
      invitations: ProjectInvitationSummary[]
    }
  | { type: "FETCH_ERROR"; error: string }

export const initialFetchState: FetchState = {
  projects: [],
  projectsLoading: true,
  permissions: null,
  members: [],
  invitations: [],
  loading: false,
  loadError: null,
}

export function fetchReducer(state: FetchState, action: FetchAction): FetchState {
  switch (action.type) {
    case "PROJECTS_LOADED":
      return { ...state, projects: action.projects, projectsLoading: false }
    case "FETCH_START":
      return { ...state, loading: true, loadError: null }
    case "FETCH_LOADED":
      return {
        ...state,
        permissions: action.permissions,
        members: action.members,
        invitations: action.invitations,
        loading: false,
        loadError: null,
      }
    case "FETCH_ERROR":
      return {
        ...state,
        members: [],
        invitations: [],
        permissions: null,
        loading: false,
        loadError: action.error,
      }
    default:
      return state
  }
}

// ----------------------------------------------------------------------------
// Invite-dialog reducer.
// ----------------------------------------------------------------------------

export interface InviteState {
  show: boolean;
  email: string;
  role: "admin" | "member";
  inviting: boolean;
  error: string | null;
  linkCallout: CreateProjectInvitationResponse | null;
}

export const initialInviteState: InviteState = {
  show: false,
  email: "",
  role: "member",
  inviting: false,
  error: null,
  linkCallout: null,
};

type InviteAction =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "SET_EMAIL"; email: string }
  | { type: "SET_ROLE"; role: "admin" | "member" }
  | { type: "INVITE_START" }
  | { type: "INVITE_SUCCESS"; linkCallout: CreateProjectInvitationResponse | null }
  | { type: "INVITE_ERROR"; error: string }
  | { type: "SET_LINK_CALLOUT"; linkCallout: CreateProjectInvitationResponse | null }
  | { type: "CLEAR_ERROR" };

export function inviteReducer(state: InviteState, action: InviteAction): InviteState {
  switch (action.type) {
    case "OPEN":
      return { ...state, show: true, error: null };
    case "CLOSE":
      return { ...state, show: false, email: "", role: "member" };
    case "SET_EMAIL":
      return { ...state, email: action.email };
    case "SET_ROLE":
      return { ...state, role: action.role };
    case "INVITE_START":
      return { ...state, inviting: true, error: null };
    case "INVITE_SUCCESS":
      return {
        ...state,
        inviting: false,
        show: false,
        email: "",
        role: "member",
        linkCallout: action.linkCallout,
      };
    case "INVITE_ERROR":
      return { ...state, inviting: false, error: action.error };
    case "SET_LINK_CALLOUT":
      return { ...state, linkCallout: action.linkCallout };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    default:
      return state;
  }
}

// ----------------------------------------------------------------------------
// Member-action reducer for ProjectMembersSection.
//
// {removeTarget, revokeTarget, busy, actionError, resendingId} all describe
// the destructive-action flow (open a confirmation, run the mutation, surface
// the outcome), so they transition as one machine. `selectedProjectId` stays a
// standalone useState — it's the picker selection that drives data fetching,
// not part of the action lifecycle.
// ----------------------------------------------------------------------------

export interface MemberActionState {
  removeTarget: ProjectMemberSummary | null
  revokeTarget: ProjectInvitationSummary | null
  busy: boolean
  actionError: string | null
  resendingId: string | null
}

type MemberAction =
  | { type: "REMOVE_TARGET_SET"; member: ProjectMemberSummary }
  | { type: "REMOVE_TARGET_CLEAR" }
  | { type: "REVOKE_TARGET_SET"; invitation: ProjectInvitationSummary }
  | { type: "REVOKE_TARGET_CLEAR" }
  | { type: "BUSY_START" }
  | { type: "BUSY_END" }
  | { type: "RESEND_START"; id: string }
  | { type: "RESEND_END" }
  | { type: "ERROR_CLEAR" }
  | { type: "ERROR_SET"; error: string }

export const initialMemberActionState: MemberActionState = {
  removeTarget: null,
  revokeTarget: null,
  busy: false,
  actionError: null,
  resendingId: null,
}

export function memberActionReducer(
  state: MemberActionState,
  action: MemberAction,
): MemberActionState {
  switch (action.type) {
    case "REMOVE_TARGET_SET":
      return { ...state, removeTarget: action.member }
    case "REMOVE_TARGET_CLEAR":
      return { ...state, removeTarget: null }
    case "REVOKE_TARGET_SET":
      return { ...state, revokeTarget: action.invitation }
    case "REVOKE_TARGET_CLEAR":
      return { ...state, revokeTarget: null }
    case "BUSY_START":
      return { ...state, busy: true, actionError: null }
    case "BUSY_END":
      return { ...state, busy: false }
    case "RESEND_START":
      return { ...state, resendingId: action.id, actionError: null }
    case "RESEND_END":
      return { ...state, resendingId: null }
    case "ERROR_CLEAR":
      return { ...state, actionError: null }
    case "ERROR_SET":
      return { ...state, actionError: action.error }
    default:
      return state
  }
}
