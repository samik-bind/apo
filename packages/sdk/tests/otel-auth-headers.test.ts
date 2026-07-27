/**
 * SPEC-149 Acceptance Tests #4 and #5: the SDK must never produce a
 * browser-public-key credential, and must never synthesize partial Basic
 * authentication from only one of `publicKey` / `secretKey`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildApoAuthHeaders } from "../src/otel/index";

describe("buildApoAuthHeaders (SPEC-149)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it("produces Basic auth when both publicKey and secretKey are provided", () => {
    const headers = buildApoAuthHeaders("pk-apo-abc", "sk-apo-xyz");
    expect(headers.Authorization).toMatch(/^Basic /);
  });

  it("produces no Authorization header when only publicKey is provided", () => {
    const headers = buildApoAuthHeaders("pk-apo-abc", undefined);
    expect(headers.Authorization).toBeUndefined();
  });

  it("produces no Authorization header when only secretKey is provided", () => {
    const headers = buildApoAuthHeaders(undefined, "sk-apo-xyz");
    expect(headers.Authorization).toBeUndefined();
  });

  it("reads both keys from env and produces Basic auth", () => {
    process.env.APO_PUBLIC_KEY = "pk-apo-env";
    process.env.APO_SECRET_KEY = "sk-apo-env";
    const headers = buildApoAuthHeaders();
    expect(headers.Authorization).toMatch(/^Basic /);
  });

  it("produces no Authorization header when only APO_PUBLIC_KEY is set", () => {
    // SPEC-149 security invariant: partial Basic (public-only) is never
    // synthesized. The public identifier does not authorize ingestion.
    process.env.APO_PUBLIC_KEY = "pk-apo-env";
    delete process.env.APO_SECRET_KEY;
    const headers = buildApoAuthHeaders();
    expect(headers.Authorization).toBeUndefined();
  });

  it("produces no Authorization header when only APO_SECRET_KEY is set", () => {
    process.env.APO_SECRET_KEY = "sk-apo-env";
    delete process.env.APO_PUBLIC_KEY;
    const headers = buildApoAuthHeaders();
    expect(headers.Authorization).toBeUndefined();
  });

  it("falls back to Bearer when APO_AUTH_TOKEN is set and no key pair is set", () => {
    delete process.env.APO_PUBLIC_KEY;
    delete process.env.APO_SECRET_KEY;
    process.env.APO_AUTH_TOKEN = "some-bearer-token";
    const headers = buildApoAuthHeaders();
    expect(headers.Authorization).toBe("Bearer some-bearer-token");
  });

  it("prefers a complete Basic pair over an auth token", () => {
    process.env.APO_PUBLIC_KEY = "pk-apo-env";
    process.env.APO_SECRET_KEY = "sk-apo-env";
    process.env.APO_AUTH_TOKEN = "some-bearer-token";
    const headers = buildApoAuthHeaders();
    expect(headers.Authorization).toMatch(/^Basic /);
  });

  it("produces no Authorization header when nothing is set", () => {
    delete process.env.APO_PUBLIC_KEY;
    delete process.env.APO_SECRET_KEY;
    delete process.env.APO_AUTH_TOKEN;
    const headers = buildApoAuthHeaders();
    expect(headers).toEqual({});
  });
});
