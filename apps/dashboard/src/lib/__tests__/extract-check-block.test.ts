import { describe, expect, it } from "vitest";
import { extractCheckBlock, resolveCheckBlock } from "../extract-check-block";

const source = `import { test } from "@apo-ai/sdk/agent-task";

test("quality", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(
    deliverables.result,
    "PASS when the answer is grounded",
  );
});
`;

describe("extractCheckBlock", () => {
  it("extracts an LLM-backed test as a normal code check", () => {
    expect(extractCheckBlock(source, { id: "quality" })).toEqual({
      code: `test("quality", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(
    deliverables.result,
    "PASS when the answer is grounded",
  );
});`,
      startLine: 3,
      endLine: 9,
    });
  });

  it("anchors the block from a failed judge assertion line", () => {
    expect(extractCheckBlock(source, { anchorLine: 5 })?.startLine).toBe(3);
  });

  it("extracts a check registered via a typed alias (const check = test<T>)", () => {
    const aliasedSource = `import { test } from "@apo-ai/sdk/agent-task";

const check = test<RealAgentDeliverables>;

check("reviewed-methodically", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(deliverables.result, "PASS when steps are listed");
});

check("used-read-and-search-tools", async (t) => {
  t.calledTool("read_file");
});
`;
    const block = extractCheckBlock(aliasedSource, { id: "reviewed-methodically" });
    expect(block).toEqual({
      code: `check("reviewed-methodically", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(deliverables.result, "PASS when steps are listed");
});`,
      startLine: 5,
      endLine: 8,
    });

    // The second alias-registered check resolves too.
    expect(extractCheckBlock(aliasedSource, { id: "used-read-and-search-tools" })?.startLine).toBe(10);
  });

  it("extracts a concise-body arrow check without swallowing the next one", () => {
    const conciseSource = `test("E3: spacedout expanded spacing", (_t, { deliverables }) =>
  expect(has(deliverables, /\\[spacedout\\]\\{[^}]*char-spacing="\\d+"/i)).toBe(true));
test("E4: shadedrun shaded, not black", (_t, { deliverables }) => {
  expect(has(deliverables, /\\[shadedrun\\]/)).toBe(true);
});
`;
    expect(extractCheckBlock(conciseSource, { id: "E3: spacedout expanded spacing" })).toEqual({
      code: `test("E3: spacedout expanded spacing", (_t, { deliverables }) =>
  expect(has(deliverables, /\\[spacedout\\]\\{[^}]*char-spacing="\\d+"/i)).toBe(true));`,
      startLine: 1,
      endLine: 2,
    });
    expect(extractCheckBlock(conciseSource, { id: "E4: shadedrun shaded, not black" })?.startLine).toBe(3);
  });

  it("extracts a trailing concise-body check (no braced check follows)", () => {
    const conciseSource = `test("last", (_t, { deliverables }) => expect(deliverables.a).toBe(1));
`;
    expect(extractCheckBlock(conciseSource, { id: "last" })?.endLine).toBe(1);
  });

  it("anchors from a failure line within an aliased check", () => {
    const aliasedSource = `const check = test<T>;
check("quality", async (t) => {
  t.calledTool("read_file");
});
`;
    expect(extractCheckBlock(aliasedSource, { anchorLine: 3 })?.startLine).toBe(2);
  });
});

// Issue #178: table-driven evals register checks with generated titles
// (`test(`P-${p.id} — …`)`) that never appear literally in the source, so
// id matching cannot find the opener. The anchor must come from the check
// result's recorded location — and the compare view holds TWO results.
const tableDrivenSource = `/** Template upload checks. */
PLACEHOLDER_TERMS.forEach((p) => {
  test(\`P-\${p.id} — a placeholder exists for \${p.label}\`, (t, { deliverables }) => {
    t.check(hasPlaceholderFor(p.id), satisfies(...));
  });
});

test("literal-title-check", (t) => {
  t.check(unrelated(), satisfies(...));
});
`;

describe("resolveCheckBlock", () => {
  it("resolves a generated-title block from the check's own assertion line", () => {
    const block = resolveCheckBlock(tableDrivenSource, {
      id: "P-reg — a placeholder exists for the company registration number",
      anchorFrom: [
        {
          location: null,
          assertions: [{ location: { line: 4 } }],
        },
      ],
    });
    expect(block?.startLine).toBe(3);
    // Ends at the check's own `});` — the forEach wrapper's close is not part
    // of the check block.
    expect(block?.endLine).toBe(5);
    expect(block?.code).toContain("P-${p.id}");
    expect(block?.code).not.toContain("literal-title-check");
  });

  it("prefers the first check that recorded an anchor, falling through to the next", () => {
    // Left has no anchor at all (location null, no assertion lines);
    // right carries one. The pair must still resolve.
    const block = resolveCheckBlock(tableDrivenSource, {
      id: "P-reg — a placeholder exists for the company registration number",
      anchorFrom: [
        { location: null, assertions: [{ location: null }] },
        { location: null, assertions: [{ location: { line: 4 } }] },
      ],
    });
    expect(block?.startLine).toBe(3);
  });

  it("still prefers a literal id match over a stale anchor", () => {
    const block = resolveCheckBlock(tableDrivenSource, {
      id: "literal-title-check",
      anchorFrom: [{ location: { line: 4 } }],
    });
    expect(block?.startLine).toBe(8);
  });

  it("returns null when neither id nor anchor can locate a block", () => {
    expect(
      resolveCheckBlock(tableDrivenSource, { id: "not-in-source", anchorFrom: [{}] }),
    ).toBeNull();
    expect(resolveCheckBlock("", { id: "x" })).toBeNull();
  });
});
