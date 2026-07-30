/**
 * PROTOTYPE ONLY: interactive shell for the apo connect lifecycle state
 * machine. No production I/O, authentication, persistence, or execution.
 */
import { emitKeypressEvents } from "node:readline";
import {
  initialState,
  transition,
  type ConnectAction,
  type ConnectState,
} from "./machine.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let state = initialState;

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
render();

process.stdin.on("keypress", (_text, key) => {
  if (key.ctrl && key.name === "c") quit();
  const action = actionFor(key.name);
  if (action === "quit") quit();
  if (action) state = transition(state, action);
  render();
});

function actionFor(key: string | undefined): ConnectAction | "quit" | null {
  switch (key) {
    case "c": return { type: "connect" };
    case "x": return { type: "disconnect" };
    case "m": return { type: "edit_metadata" };
    case "s": return { type: "edit_source" };
    case "w": return { type: "watcher_sync" };
    case "r": return { type: "dashboard_run" };
    case "k": return { type: "runner_claim" };
    case "f": return { type: "finish" };
    case "z": return { type: "reset_job" };
    case "q": return "quit";
    default: return null;
  }
}

function render(): void {
  console.clear();
  console.log(`${BOLD}PROTOTYPE — apo connect lifecycle${RESET}`);
  console.log(`${DIM}Can one foreground connection hide Pool/Executor machinery?${RESET}\n`);
  field("connection", state.connection);
  field("local catalog", revision(state.localCatalogRevision));
  field("published catalog", revision(state.publishedCatalogRevision));
  field("local source", revision(state.localSourceRevision));
  field("advertised source", revision(state.advertisedSourceRevision));
  field("dashboard job", describeJob(state));
  console.log(`\n${BOLD}Last transition${RESET}\n${state.message}`);
  console.log(`\n${BOLD}Actions${RESET}`);
  console.log(
    `${BOLD}[c]${RESET} connect  ${BOLD}[x]${RESET} disconnect  ` +
    `${BOLD}[m]${RESET} edit metadata  ${BOLD}[s]${RESET} edit source`,
  );
  console.log(
    `${BOLD}[w]${RESET} watcher sync  ${BOLD}[r]${RESET} dashboard Run  ` +
    `${BOLD}[k]${RESET} runner claim  ${BOLD}[f]${RESET} finish`,
  );
  console.log(`${BOLD}[z]${RESET} clear job  ${BOLD}[q]${RESET} quit`);
}

function field(name: string, value: string): void {
  console.log(`${BOLD}${name.padEnd(20)}${RESET} ${value}`);
}

function revision(value: number | null): string {
  return value === null ? `${DIM}none${RESET}` : `revision-${value}`;
}

function describeJob(current: ConnectState): string {
  const job = current.job;
  if (job.status === "none") return `${DIM}none${RESET}`;
  if (job.status === "blocked") return `blocked (${job.reason})`;
  if (job.status === "queued") {
    return `queued (catalog-${job.expectedCatalogRevision}, source-${job.expectedSourceRevision})`;
  }
  return `${job.status} (catalog-${job.catalogRevision}, source-${job.sourceRevision})`;
}

function quit(): never {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  console.clear();
  process.exit(0);
}
