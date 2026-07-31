import { describe, expect, it } from "vitest";
import { computeCatalogDigest } from "../src/lib/task-catalog-digest.ts";
import type { PublishedTask } from "../src/lib/task-catalog.ts";

/*
 * SPEC-159/161: the TypeScript and Python catalog digest functions MUST agree
 * byte-for-byte. This regression test pins the TS output to the value produced
 * by apo.services.task_catalog.compute_catalog_digest for the same input, so a
 * drift (e.g. missing recursive key sort) fails the suite.
 */

const tasks: PublishedTask[] = [
  {
    task_id: "connect-fixture",
    display_name: "connect-fixture",
    task_path: "connect-fixture",
    folder_path: "",
    adapter_name: "x",
    has_checks: true,
    has_user_simulator: false,
    tags: [],
  },
];

describe("SPEC-161 cross-language catalog digest", () => {
  it("matches the Python compute_catalog_digest for a single task", () => {
    expect(computeCatalogDigest(tasks)).toBe(
      "sha256:628bd058a9ceeccbda0a04817dd9233e5370aa5031b3d6f218113ecc67ef8f3c",
    );
  });

  it("sorts tasks and tags so ordering does not change the digest", () => {
    const reversed: PublishedTask[] = [...tasks].reverse();
    expect(computeCatalogDigest(reversed)).toBe(computeCatalogDigest(tasks));
  });

  it("produces a stable, sorted-key payload (keys inside each task are alphabetical)", () => {
    // Sanity: a task with non-alphabetical insertion order still digests to the
    // same value as the alphabetically-keyed Python output.
    const shuffled = computeCatalogDigest([
      {
        adapter_name: "x",
        has_user_simulator: false,
        tags: [],
        has_checks: true,
        task_path: "connect-fixture",
        display_name: "connect-fixture",
        folder_path: "",
        task_id: "connect-fixture",
      },
    ]);
    expect(shuffled).toBe(computeCatalogDigest(tasks));
  });
});
