/**
 * Configuration management for apo SDK.
 *
 * Centralizes environment variable reading so all wrappers use the same logic.
 */

export interface EnvConfig {
  /** Backend endpoint URL */
  endpoint: string;
  /** Project name for optimization tracking */
  project: string;
  /**
   * Public identifier for the two-key model. this is the
   * ``pk-apo-*`` value, used as the Basic-auth username alongside
   * ``secretKey``. It is NOT a usable credential on its own — the SDK
   * never reads ``NEXT_PUBLIC_APO_PUBLIC_KEY`` because publishing a public
   * identifier in a browser bundle creates a misleading direct-browser
   * integration. Server-only.
   */
  publicKey?: string;
  /** Secret key for two-key auth (server-only). */
  secretKey?: string;
  /** Legacy single-key auth token */
  apiKey?: string;
}

/**
 * Read optimizer configuration from environment variables.
 *
 * This function centralizes all environment variable reading for the SDK,
 * ensuring consistent behavior across all wrapper functions.
 *
 * **Environment Variables (in order of priority):**
 *
 * For `endpoint`:
 * - `NEXT_PUBLIC_APO_BACKEND_URL` (Next.js public env var)
 * - `APO_BACKEND_URL` (standard env var)
 * - Falls back to `http://localhost:8000`
 *
 * For `project`:
 * - `APO_PROJECT` (standard env var)
 * - `NEXT_PUBLIC_APO_PROJECT` (Next.js public env var)
 * - Falls back to `default-project`
 *
 * For `publicKey`:
 * - `APO_PUBLIC_KEY` (server-side public identifier; paired with
 *   `APO_SECRET_KEY` to form HTTP Basic credentials). Support for `NEXT_PUBLIC_APO_PUBLIC_KEY` was removed:
 *   the public identifier alone
 *   does not authorize ingestion, so publishing it as a browser-safe env
 *   var is actively misleading.
 *
 * For `secretKey`:
 * - `APO_SECRET_KEY` (server-side only)
 *
 * For `apiKey` (legacy single-key auth):
 * - `APO_API_KEY`
 *
 * @example
 * ```ts
 * import { readConfig } from "@apo-ai/sdk";
 *
 * const config = readConfig();
 * console.log(config.endpoint); // "http://localhost:8000" or env value
 * console.log(config.project);  // "default-project" or env value
 * ```
 *
 * @returns Client configuration from environment
 */
export function readConfig(): EnvConfig {
  const endpoint =
    process.env.NEXT_PUBLIC_APO_BACKEND_URL ??
    process.env.APO_BACKEND_URL ??
    "http://localhost:8000";

  const project =
    process.env.APO_PROJECT ??
    process.env.NEXT_PUBLIC_APO_PROJECT ??
    "default-project";

  const publicKey = process.env.APO_PUBLIC_KEY;

  const secretKey = process.env.APO_SECRET_KEY;
  const apiKey = process.env.APO_API_KEY;

  return { endpoint, project, publicKey, secretKey, apiKey };
}
