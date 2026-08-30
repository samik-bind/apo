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

export type PickOption<T> = { label: string; hint?: string; value: T };
export type PickResult<T> =
  | { kind: "pick"; value: T }
  | { kind: "switch" }
  | { kind: "back" };

/**
 * Arrow-key/j-k/number picker, redrawn in place. Enter picks; Tab requests
 * a variant switch; Esc goes back. Degrades to the default when stdin is
 * not a TTY so the prototype stays previewable.
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

    let rendered = false;
    const render = () => {
      if (rendered) process.stdout.write(`\x1b[${options.length}A`);
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const selected = i === index;
        const marker = selected ? "\u276f" : " ";
        const label = selected ? opt.label : `\x1b[2m${opt.label}\x1b[0m`;
        const hint = opt.hint ? `  \x1b[2m${opt.hint}\x1b[0m` : "";
        process.stdout.write(`\x1b[2K\r${marker} ${label}${hint}\n`);
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
