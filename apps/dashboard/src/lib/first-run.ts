/**
 * SPEC-180: structured builders for the first-run onboarding commands.
 *
 * Values are validated and quoted for shell display/copy only — the
 * dashboard never interpolates raw values into HTML and never invokes a
 * shell itself.
 */

export interface ProjectFirstRunSetup {
  publicUrl: string;
  projectId: string;
  cliLoginCommand: string;
  docsUrl: string;
  exampleUrl: string;
}

/** True when the origin is an absolute http(s) URL safe to render in a command. */
export function isValidPublicOrigin(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/** Quote a value for safe display inside a POSIX-flavored shell command. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]+$/.test(value) && !value.includes("'")) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const HOSTED_DOCS_URL = "/docs/hosted-alpha";
export const EXAMPLE_URL =
  "https://github.com/samikuikka/apo/tree/main/apps/example-service/e2e/agent-task-demo";

/** The one command an invited owner runs first: exact backend + exact Project. */
export function buildCliLoginCommand(publicUrl: string, projectId: string): string {
  return `apo login --backend ${shellQuote(publicUrl)} --project ${shellQuote(projectId)}`;
}
