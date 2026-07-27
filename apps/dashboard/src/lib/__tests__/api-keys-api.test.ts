/**
 * SPEC-149 Acceptance Test #3: the dashboard API helper defaults to the
 * least-privileged ``ingest`` scope. The previous default of ``full`` made
 * every dashboard-minted key a management credential, which is unsafe for
 * the common telemetry-producer issuance flow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config", () => ({
  getBrowserBackendBaseUrl: () => "http://localhost:8000",
}));

vi.mock("../backend-fetch", () => ({
  backendFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

import { createApiKey } from "../api-keys-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        id: "k1",
        name: "n",
        prefix: "p",
        project: "proj",
        created_by: "u",
        scope: "ingest",
        created_at: "now",
        last_used_at: null,
        expires_at: null,
      }),
  });
});

describe("createApiKey default scope (SPEC-149)", () => {
  it("defaults to ingest when scope is omitted", async () => {
    await createApiKey("Production", "example-service");
    const [, init] = mockFetch.mock.calls[0];
    expect(init?.body).toEqual(
      JSON.stringify({
        name: "Production",
        project: "example-service",
        scope: "ingest",
        expires_at: null,
      }),
    );
  });

  it("still passes an explicit full scope through", async () => {
    await createApiKey("CLI", "example-service", "full");
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(init?.body)).scope).toBe("full");
  });
});
