"use client";

import { useState, useEffect, useReducer, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ChevronsUpDown, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Project, listProjects, createProject } from "@/lib/projects-api";

function setActiveProjectCookie(projectId: string) {
  document.cookie = `active-project=${projectId};path=/;max-age=604800;samesite=lax`;
}

// ----------------------------------------------------------------------------
// Switcher dropdown UI reducer.
//
// {open, showCreate, newName, loading} describe one interactive surface — the
// dropdown, its inline create form, and the create submit lifecycle — so they
// transition as a single machine. The fetched projects list is separate server
// data and keeps its own useState.
// ----------------------------------------------------------------------------

interface SwitcherUiState {
  open: boolean;
  showCreate: boolean;
  newName: string;
  loading: boolean;
}

type SwitcherUiAction =
  | { type: "OPEN_TOGGLE" }
  | { type: "CLOSE" } // after switching projects: hide the dropdown only
  | { type: "DISMISS" } // outside click: hide the dropdown and the create form
  | { type: "CREATE_SHOW" }
  | { type: "NAME_SET"; name: string }
  | { type: "CREATE_START" }
  | { type: "CREATE_SUCCESS" } // clears the form and closes the dropdown
  | { type: "LOADING_END" }; // create finished (success or failure)

const initialSwitcherUiState: SwitcherUiState = {
  open: false,
  showCreate: false,
  newName: "",
  loading: false,
};

function switcherUiReducer(
  state: SwitcherUiState,
  action: SwitcherUiAction,
): SwitcherUiState {
  switch (action.type) {
    case "OPEN_TOGGLE":
      return { ...state, open: !state.open };
    case "CLOSE":
      return { ...state, open: false };
    case "DISMISS":
      return { ...state, open: false, showCreate: false };
    case "CREATE_SHOW":
      return { ...state, showCreate: true };
    case "NAME_SET":
      return { ...state, newName: action.name };
    case "CREATE_START":
      return { ...state, loading: true };
    case "CREATE_SUCCESS":
      return { ...state, open: false, showCreate: false, newName: "" };
    case "LOADING_END":
      return { ...state, loading: false };
  }
}

export function ProjectSwitcher({ currentProjectId }: { currentProjectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [projects, setProjects] = useState<Project[]>([]);
  const [ui, dispatch] = useReducer(switcherUiReducer, initialSwitcherUiState);
  const { open, showCreate, newName, loading } = ui;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listProjects()
      .then((ps) => setProjects(ps.filter((p) => p.id !== "demo")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        dispatch({ type: "DISMISS" });
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const current = projects.find((p) => p.id === currentProjectId);

  function switchTo(projectId: string) {
    setActiveProjectCookie(projectId);
    const newPath = pathname.replace(/\/project\/[^/]+/, `/project/${projectId}`);
    router.push(newPath);
    dispatch({ type: "CLOSE" });
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    dispatch({ type: "CREATE_START" });
    try {
      const project = await createProject(newName.trim());
      setProjects((prev) => [project, ...prev]);
      dispatch({ type: "CREATE_SUCCESS" });
      switchTo(project.id);
    } finally {
      dispatch({ type: "LOADING_END" });
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => dispatch({ type: "OPEN_TOGGLE" })}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/40"
      >
        <span className="truncate text-foreground">{current?.name ?? currentProjectId}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full min-w-[240px] rounded-md border border-border bg-popover p-1 shadow-md">
          {/* User's projects first */}
          {projects.length > 0 ? (
            <>
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => switchTo(p.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/40",
                    p.id === currentProjectId && "bg-muted/30 font-semibold",
                  )}
                >
                  <span className="truncate text-foreground">{p.name}</span>
                  {p.id === currentProjectId && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              ))}
            </>
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No projects yet</p>
          )}

          {/* Create new */}
          <div className="my-1 border-t border-border/50" />

          {showCreate ? (
            <div className="p-1">
              <label htmlFor="switcher-project-name" className="mb-1 block px-1 text-xs text-muted-foreground">
                Project name
              </label>
              <input
                id="switcher-project-name"
                value={newName}
                onChange={(e) => dispatch({ type: "NAME_SET", name: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Project name"
                className="h-8 w-full rounded-sm border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={loading || !newName.trim()}
                className="mt-1 w-full rounded-sm bg-primary px-2 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {loading ? "Creating..." : "Create project"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => dispatch({ type: "CREATE_SHOW" })}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/40"
            >
              <Plus className="size-3.5" />
              New project
            </button>
          )}

          {/* Demo at the bottom */}
          <div className="my-1 border-t border-border/50" />
          <button
            type="button"
            onClick={() => switchTo("demo")}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/40",
              "demo" === currentProjectId && "bg-muted/30 font-semibold",
            )}
          >
            <span className="truncate">Demo workspace</span>
            {"demo" === currentProjectId && <Check className="size-3 shrink-0 text-primary" />}
          </button>
        </div>
      )}
    </div>
  );
}
