import { afterEach, describe, expect, it, vi } from "vitest";

describe("public ingress routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves the canonical OTLP path before the generic API rewrite", async () => {
    vi.stubEnv("BACKEND_URL", "http://backend:8000");
    const { default: nextConfig } = await import("../../../next.config.mjs");

    const rewrites = await nextConfig.rewrites?.();

    expect(Array.isArray(rewrites)).toBe(true);
    if (!Array.isArray(rewrites)) {
      throw new Error("expected array-form Next.js rewrites");
    }
    expect(rewrites[0]).toEqual({
      source: "/api/public/otel/:path*",
      destination: "http://backend:8000/api/public/otel/:path*",
    });
  });
});

describe("public origin serves the CLI", () => {
  it("routes /v1/* and /auth/* to the backend", async () => {
    vi.stubEnv("BACKEND_URL", "http://backend:8000");
    const { default: nextConfig } = await import("../../../next.config.mjs");

    const rewrites = await nextConfig.rewrites?.();
    expect(Array.isArray(rewrites)).toBe(true);
    if (!Array.isArray(rewrites)) throw new Error("expected array-form rewrites");

    const sources = rewrites.map((r) => r.source);
    expect(sources).toContain("/v1/:path*");
    expect(sources).toContain("/auth/:path*");
    const v1 = rewrites.find((r) => r.source === "/v1/:path*");
    expect(v1?.destination).toBe("http://backend:8000/v1/:path*");
    const auth = rewrites.find((r) => r.source === "/auth/:path*");
    expect(auth?.destination).toBe("http://backend:8000/auth/:path*");
  });

  it("never maps the NextAuth-owned /api/auth/* surface to the backend", async () => {
    vi.stubEnv("BACKEND_URL", "http://backend:8000");
    const { default: nextConfig } = await import("../../../next.config.mjs");

    const rewrites = await nextConfig.rewrites?.();
    if (!Array.isArray(rewrites)) throw new Error("expected array-form rewrites");

    for (const rule of rewrites) {
      expect(rule.source).not.toMatch(/^\/api\/auth/);
    }
  });
});
