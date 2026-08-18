/**
 * The archive call puts the model in the request body, not the path.
 *
 * Model ids can carry a provider prefix (`openai/gpt-5.1`). A path segment
 * cannot hold that safely, so "simplifying" this into
 * `PUT .../archived-models/{model}` would silently break those ids — this test
 * is here to make that regression loud.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client", () => ({ apiClient: vi.fn() }));

import { apiClient } from "../api-client";
import { setModelArchived } from "../agent-task-view-api";

describe("setModelArchived", () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(apiClient).mockResolvedValue({ model: "m", archived: true });
  });

  it("PUTs the model and flag in the body", async () => {
    await setModelArchived("proj-1", "claude-opus-5", true);
    expect(apiClient).toHaveBeenCalledWith("/v1/projects/proj-1/archived-models", {
      method: "PUT",
      body: { model: "claude-opus-5", archived: true },
    });
  });

  it("keeps a provider-qualified model intact rather than in the path", async () => {
    await setModelArchived("proj-1", "openai/gpt-5.1", true);
    const [path, init] = vi.mocked(apiClient).mock.calls[0]!;
    expect(path).toBe("/v1/projects/proj-1/archived-models");
    expect(init).toMatchObject({ body: { model: "openai/gpt-5.1" } });
  });

  it("un-archives through the same endpoint", async () => {
    await setModelArchived("proj-1", "pi:claude-opus-5", false);
    expect(apiClient).toHaveBeenCalledWith("/v1/projects/proj-1/archived-models", {
      method: "PUT",
      body: { model: "pi:claude-opus-5", archived: false },
    });
  });

  it("encodes the project id", async () => {
    await setModelArchived("proj/1", "claude-opus-5", true);
    expect(vi.mocked(apiClient).mock.calls[0]![0]).toBe(
      "/v1/projects/proj%2F1/archived-models",
    );
  });
});
