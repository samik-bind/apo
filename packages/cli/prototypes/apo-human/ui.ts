/**
 * PROTOTYPE ONLY — keyboard input + rendering helpers for the apo-human
 * prototype shells. A tab-aware local picker (the production pickOption
 * can't intercept Tab for variant switching) and the shared bottom bar.
 */
import { emitKeypressEvents } from "node:readline";
import { stdin } from "node:process";
import { bold, dim } from "../../src/lib/format.ts";

export type Key = { name: string; ctrl: boolean };

let keypressReady = false;

export function initInput(): void {
  if (keypressReady) return;
  emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  keypressReady = true;
}

export function shutdownInput(): void {
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
}

export function waitKey(): Promise<Key> {
  return new Promise((resolve) => {
    const onKey = (_ch: string, key: Key) => {
      if (key?.ctrl && key.name === "c") {
        shutdownInput();
        process.exit(130);
      }
      stdin.removeListener("keypress", onKey);
      resolve(key ?? { name: _ch, ctrl: false });
    };
    stdin.on("keypress", onKey);
  });
}

export type PickOption<T> = { label: string; hint?: string; sub?: string; value: T };
export type PickResult<T> =
  | { kind: "pick"; value: T }
  | { kind: "switch" }
  | { kind: "back" };

/**
 * Arrow-key/j-k/number picker, redrawn in place. Enter picks; Tab requests
 * a variant switch; Esc goes back. Options are two-line entries when `sub`
 * is set: the label (the thing you choose by) on line one, the `sub`
 * context (description, pricing) dim on line two — one fact per line.
 * Degrades to the default when stdin is not a TTY.
 */
export async function pick<T>(
  title: string,
  options: PickOption<T>[],
  defaultIndex = 0,
): Promise<PickResult<T>> {
  if (options.length === 0) return { kind: "back" };
  let index = Math.min(Math.max(defaultIndex, 0), options.length - 1);

  if (!stdin.isTTY) return { kind: "pick", value: options[index].value };

  return new Promise<PickResult<T>>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?25l");
    process.stdout.write(`${title}\n`);

    const width = process.stdout.columns ?? 80;
    let renderedLines = 0;
    let rendered = false;
    const render = () => {
      if (rendered) process.stdout.write(`\x1b[${renderedLines}A`);
      renderedLines = 0;
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const selected = i === index;
        const marker = selected ? "\u276f" : " ";
        const label = selected ? bold(opt.label) : dim(opt.label);
        const hint = opt.hint ? `  ${dim(opt.hint)}` : "";
        process.stdout.write(`\x1b[2K\r${marker} ${label}${hint}\n`);
        renderedLines++;
        if (opt.sub) {
          process.stdout.write(`\x1b[2K\r    ${dim(truncate(opt.sub, width - 6))}\n`);
          renderedLines++;
        }
      }
      rendered = true;
    };

    const finish = (result: PickResult<T>) => {
      stdin.removeListener("keypress", onKey);
      process.stdout.write("\x1b[?25h");
      resolve(result);
    };

    const onKey = (_ch: string, key: Key) => {
      if (key?.ctrl && key.name === "c") {
        shutdownInput();
        process.exit(130);
      }
      switch (key?.name) {
        case "up":
        case "k":
          index = Math.max(0, index - 1);
          render();
          return;
        case "down":
        case "j":
          index = Math.min(options.length - 1, index + 1);
          render();
          return;
        case "return":
        case "enter":
          finish({ kind: "pick", value: options[index].value });
          return;
        case "tab":
          finish({ kind: "switch" });
          return;
        case "escape":
        case "b":
          finish({ kind: "back" });
          return;
      }
      if (_ch >= "1" && _ch <= "9") {
        const n = Number(_ch) - 1;
        if (n < options.length) {
          index = n;
          render();
        }
      }
    };

    render();
    stdin.on("keypress", onKey);
  });
}

function truncate(text: string, width: number): string {
  return text.length > width && width > 1 ? `${text.slice(0, width - 1)}…` : text;
}

export type TreeNode<T> = {
  name: string;
  /** Stable identity for expansion state (folder path or task id). */
  key: string;
  /** Folder rows carry children + a task count; task rows carry a value. */
  children?: TreeNode<T>[];
  value?: T;
  hint?: string;
  count?: number;
};

type VisibleRow<T> = { node: TreeNode<T>; depth: number; isFolder: boolean; parent: TreeNode<T> | null };

/**
 * Collapsible tree picker: ↑↓ move, →/l opens a folder (descends when
 * already open), ←/h closes the cursor's folder or its nearest open
 * ancestor, Enter opens/closes folders and picks tasks. The `expanded` set
 * is the caller's — it persists across visits and variant switches.
 */
export async function pickTree<T>(
  title: string,
  roots: TreeNode<T>[],
  expanded: Set<string>,
): Promise<PickResult<T>> {
  const flatten = (): VisibleRow<T>[] => {
    const rows: VisibleRow<T>[] = [];
    const walk = (nodes: TreeNode<T>[], depth: number, parent: TreeNode<T> | null) => {
      for (const n of nodes) {
        rows.push({ node: n, depth, isFolder: n.children !== undefined, parent });
        if (n.children && expanded.has(n.key)) walk(n.children, depth + 1, n);
      }
    };
    walk(roots, 0, null);
    return rows;
  };

  if (!stdin.isTTY) {
    const first = flatten().find((r) => !r.isFolder);
    return first?.node.value !== undefined ? { kind: "pick", value: first.node.value } : { kind: "back" };
  }

  return new Promise<PickResult<T>>((resolve) => {
    let cursor = 0;
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?25l");
    process.stdout.write(`${title}\n`);

    let renderedLines = 0;
    let rendered = false;
    const render = () => {
      const rows = flatten();
      cursor = Math.min(Math.max(cursor, 0), rows.length - 1);
      if (rendered) process.stdout.write(`\x1b[${renderedLines}A`);
      renderedLines = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const selected = i === cursor;
        const marker = selected ? "\u276f" : " ";
        const indent = "  ".repeat(r.depth);
        let line: string;
        if (r.isFolder) {
          const arrow = expanded.has(r.node.key) ? "\u25be" : "\u25b8";
          const name = selected ? bold(`${arrow} ${r.node.name}`) : dim(`${arrow} ${r.node.name}`);
          line = `${marker} ${indent}${name}  ${dim(String(r.node.count ?? ""))}`;
        } else {
          const name = selected ? bold(r.node.name) : dim(r.node.name);
          line = `${marker} ${indent}  ${name}${r.node.hint ? `  ${dim(r.node.hint)}` : ""}`;
        }
        process.stdout.write(`\x1b[2K\r${line}\n`);
        renderedLines++;
      }
      rendered = true;
    };

    const finish = (result: PickResult<T>) => {
      stdin.removeListener("keypress", onKey);
      process.stdout.write("\x1b[?25h");
      resolve(result);
    };

    const onKey = (_ch: string, key: Key) => {
      if (key?.ctrl && key.name === "c") {
        shutdownInput();
        process.exit(130);
      }
      const rows = flatten();
      const row = rows[cursor];
      switch (key?.name) {
        case "up":
        case "k":
          cursor = Math.max(0, cursor - 1);
          render();
          return;
        case "down":
        case "j":
          cursor = Math.min(rows.length - 1, cursor + 1);
          render();
          return;
        case "right":
        case "l":
          if (row?.isFolder) {
            if (!expanded.has(row.node.key)) expanded.add(row.node.key);
            else cursor = Math.min(cursor + 1, rows.length - 1);
            render();
          }
          return;
        case "left":
        case "h": {
          if (!row) return;
          if (row.isFolder && expanded.has(row.node.key)) {
            expanded.delete(row.node.key);
          } else {
            // close the nearest open ancestor and land on it
            let parent = row.parent;
            while (parent && !expanded.has(parent.key)) parent = findParent(roots, parent.key);
            if (parent) {
              expanded.delete(parent.key);
              cursor = Math.max(0, flatten().findIndex((r) => r.node.key === parent!.key));
            }
          }
          render();
          return;
        }
        case "return":
        case "enter":
          if (!row) return;
          if (row.isFolder) {
            if (expanded.has(row.node.key)) expanded.delete(row.node.key);
            else expanded.add(row.node.key);
            render();
          } else if (row.node.value !== undefined) {
            finish({ kind: "pick", value: row.node.value });
          }
          return;
        case "tab":
          finish({ kind: "switch" });
          return;
        case "escape":
        case "b":
          finish({ kind: "back" });
          return;
      }
    };

    render();
    stdin.on("keypress", onKey);
  });
}

/** Walk to a node's parent by key (flatten() only tracks one level). */
function findParent<T>(nodes: TreeNode<T>[], key: string, parent: TreeNode<T> | null = null): TreeNode<T> | null {
  for (const n of nodes) {
    if (n.key === key) return parent;
    if (n.children) {
      const found = findParent(n.children, key, n);
      if (found !== null || n.children.some((c) => c.key === key)) return found;
    }
  }
  return null;
}

/** Line input: drops to cooked mode so the terminal handles echo/editing. */
export function askText(title: string, fallback: string): Promise<string> {
  if (!stdin.isTTY) return Promise.resolve(fallback);
  stdin.setRawMode(false);
  stdin.resume();
  process.stdout.write(`${title} ${dim(`[${fallback}]`)}: `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const line = chunk.toString("utf8").replace(/\r?\n$/, "");
      stdin.removeListener("data", onData);
      stdin.setRawMode(true);
      process.stdout.write("\n");
      resolve(line.trim() || fallback);
    };
    stdin.once("data", onData);
  });
}

export const VARIANT_NAMES = ["wizard", "menu", "dashboard"] as const;

export function bottomBar(variantIndex: number): string {
  const names = VARIANT_NAMES.map((n, i) =>
    i === variantIndex ? bold(n) : dim(n),
  ).join(dim(" · "));
  return `\n${dim("[Tab]")} switch variant  ${dim("[q]")} quit   ${names}`;
}
