export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Every value seen for a flag, in order (supports repeatable flags). */
  multiFlags: Record<string, string[]>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multiFlags: Record<string, string[]> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--") {
      break;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      i += 1;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      flags.version = true;
      i += 1;
      continue;
    }

    if (arg === "--json") {
      flags.json = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
      const next = inlineValue === undefined ? argv[i + 1] : undefined;

      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        (multiFlags[key] ??= []).push(inlineValue);
        i += 1;
      } else if (next && !next.startsWith("--")) {
        flags[key] = next;
        (multiFlags[key] ??= []).push(next);
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
      continue;
    }

    positional.push(arg);
    i += 1;
  }

  return { positional, flags, multiFlags };
}

export function requirePositional(
  positional: string[],
  index: number,
  name: string,
): string {
  const value = positional[index];
  if (!value) {
    throw new Error(`Missing required argument: <${name}>`);
  }
  return value;
}

export function getFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

export function getBoolFlag(
  flags: Record<string, string | boolean>,
  name: string,
): boolean {
  return flags[name] === true || flags[name] === "true";
}

export { getFlag as getFlagValue };

/** Read every value for a (possibly repeatable) flag. Empty when absent. */
export function getFlagValues(
  multiFlags: Record<string, string[]>,
  name: string,
): string[] {
  return multiFlags[name] ?? [];
}
