export type ConnectionState = "disconnected" | "connected";

export type Job =
  | { status: "none" }
  | {
      status: "queued";
      expectedCatalogRevision: number;
      expectedSourceRevision: number;
    }
  | {
      status: "running";
      catalogRevision: number;
      sourceRevision: number;
    }
  | {
      status: "blocked";
      reason: "runner_offline" | "catalog_moved" | "source_moved";
    }
  | {
      status: "succeeded";
      catalogRevision: number;
      sourceRevision: number;
    };

export type ConnectState = {
  connection: ConnectionState;
  localCatalogRevision: number;
  localSourceRevision: number;
  publishedCatalogRevision: number | null;
  advertisedSourceRevision: number | null;
  job: Job;
  message: string;
};

export type ConnectAction =
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "edit_metadata" }
  | { type: "edit_source" }
  | { type: "watcher_sync" }
  | { type: "dashboard_run" }
  | { type: "runner_claim" }
  | { type: "finish" }
  | { type: "reset_job" };

export const initialState: ConnectState = {
  connection: "disconnected",
  localCatalogRevision: 1,
  localSourceRevision: 1,
  publishedCatalogRevision: null,
  advertisedSourceRevision: null,
  job: { status: "none" },
  message: "Run apo connect from the private checkout.",
};

export function transition(
  state: ConnectState,
  action: ConnectAction,
): ConnectState {
  switch (action.type) {
    case "connect":
      return {
        ...state,
        connection: "connected",
        publishedCatalogRevision: state.localCatalogRevision,
        advertisedSourceRevision: state.localSourceRevision,
        message: "Connected: catalog published and local source advertised.",
      };
    case "disconnect":
      return {
        ...state,
        connection: "disconnected",
        advertisedSourceRevision: null,
        message: "Disconnected: history remains, but dashboard Run is unavailable.",
      };
    case "edit_metadata":
      return {
        ...state,
        localCatalogRevision: state.localCatalogRevision + 1,
        localSourceRevision: state.localSourceRevision + 1,
        message: "Task metadata changed locally; the watcher has not synced it yet.",
      };
    case "edit_source":
      return {
        ...state,
        localSourceRevision: state.localSourceRevision + 1,
        message: "Source changed locally; the watcher has not advertised it yet.",
      };
    case "watcher_sync":
      if (state.connection === "disconnected") {
        return { ...state, message: "Nothing synced: apo connect is not running." };
      }
      return {
        ...state,
        publishedCatalogRevision: state.localCatalogRevision,
        advertisedSourceRevision: state.localSourceRevision,
        message: "Watcher synced metadata and advertised the current source digest.",
      };
    case "dashboard_run":
      if (
        state.connection === "disconnected" ||
        state.advertisedSourceRevision === null ||
        state.publishedCatalogRevision === null
      ) {
        return {
          ...state,
          job: { status: "blocked", reason: "runner_offline" },
          message: "Dashboard refused Run because no matching checkout is online.",
        };
      }
      return {
        ...state,
        job: {
          status: "queued",
          expectedCatalogRevision: state.publishedCatalogRevision,
          expectedSourceRevision: state.advertisedSourceRevision,
        },
        message: "Dashboard queued a run pinned to the advertised checkout.",
      };
    case "runner_claim":
      return claimJob(state);
    case "finish":
      if (state.job.status !== "running") {
        return { ...state, message: "Nothing finished: no Task is running." };
      }
      return {
        ...state,
        job: {
          status: "succeeded",
          catalogRevision: state.job.catalogRevision,
          sourceRevision: state.job.sourceRevision,
        },
        message: "Run completed; results and traces are now in Apo.",
      };
    case "reset_job":
      return {
        ...state,
        job: { status: "none" },
        message: "Dashboard job cleared.",
      };
  }
}

function claimJob(state: ConnectState): ConnectState {
  if (state.job.status !== "queued") {
    return { ...state, message: "Nothing claimed: no dashboard job is queued." };
  }
  if (state.connection === "disconnected") {
    return {
      ...state,
      job: { status: "blocked", reason: "runner_offline" },
      message: "Claim failed because the connected checkout went offline.",
    };
  }
  if (state.job.expectedCatalogRevision !== state.localCatalogRevision) {
    return {
      ...state,
      job: { status: "blocked", reason: "catalog_moved" },
      message: "Claim refused: Task metadata changed after the dashboard queued it.",
    };
  }
  if (state.job.expectedSourceRevision !== state.localSourceRevision) {
    return {
      ...state,
      job: { status: "blocked", reason: "source_moved" },
      message: "Claim refused: source changed after the dashboard queued it.",
    };
  }
  return {
    ...state,
    job: {
      status: "running",
      catalogRevision: state.localCatalogRevision,
      sourceRevision: state.localSourceRevision,
    },
    message: "Runner claimed the pinned job and started the local Task.",
  };
}
