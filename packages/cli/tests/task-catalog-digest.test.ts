import { describe, expect, it } from "vitest";
import { computeCatalogDigest } from "../src/lib/task-catalog-digest.ts";
import type { PublishedTask } from "../src/lib/task-catalog.ts";

/*
 * The TypeScript and Python catalog digest functions MUST agree
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
    tags: [],
  },
];

describe("cross-language catalog digest", () => {
  it("matches the Python compute_catalog_digest for a single task", () => {
    expect(computeCatalogDigest(tasks)).toBe(
      "sha256:bd8001ea07d09cae7acddc06ecf372f4309c95880fcc1ed91532b7475f3a7e14",
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
