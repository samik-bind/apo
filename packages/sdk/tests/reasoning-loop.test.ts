import { describe, expect, it } from "vitest";

import {
  diversity,
  foldForRepetition,
  RepetitionGuard,
  type ReasoningLoopTrip,
} from "../src/agent-task/checks/reasoning-loop.ts";

/** Feed `text` in `deltaChars`-sized deltas, as a stream would. */
function replay(text: string, opts = { diversity: true }, deltaChars = 7): ReasoningLoopTrip | undefined {
  const guard = new RepetitionGuard(opts);
  for (let i = 0; i < text.length; i += deltaChars) {
    if (guard.push(text.slice(i, i + deltaChars))) break;
  }
  return guard.tripped;
}

/** Deterministic PRNG so the varied fixtures are the same on every run. */
function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

const SUBJECTS = ["the clause", "section 4.2", "the second paragraph", "the summary", "the cited figure", "the reply", "the table caption", "the closing note"];
const VERBS = ["states", "omits", "repeats", "contradicts", "qualifies", "narrows", "restates", "softens"];
const OBJECTS = ["the deadline", "the payment term", "the liability cap", "the notice period", "the exception", "the fee", "the scope", "the renewal date"];
const LINKS = ["However,", "So", "Wait,", "Also,", "On the other hand,", "Then again,", "Still,", "Hmm, but"];

/** Long, varied analysis prose, with paragraph breaks like real reasoning. */
function variedReasoning(sentences: number, seed = 1): string {
  const rand = prng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    out.push(
      `${pick(LINKS)} ${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} (item ${i + 1}, ${Math.floor(rand() * 900) + 10} days).`,
    );
    if (i % 6 === 5) out.push("\n\n");
  }
  return out.join(" ");
}

describe("foldForRepetition", () => {
  it("keeps lowercase letters and digits and caps one-char runs at 3", () => {
    expect(foldForRepetition("Hmm. HMMMMM, ok!! 2000")).toBe("hmmhmmmok2000");
    expect(foldForRepetition("Ääkköset – 12")).toBe("ääkköset12");
  });
});

describe("RepetitionGuard", () => {
  it("trips on a stream that degenerates into 'Hmm. ' × N", () => {
    const text = variedReasoning(200) + "Hmm. ".repeat(2_000);
    const trip = replay(text);
    expect(trip).toMatchObject({ rule: "repeated-unit", copies: 333 });
    // Cut ~334 copies into the loop, not at its end.
    const loopStart = text.indexOf("Hmm. Hmm. Hmm.");
    expect(trip!.atChar - loopStart).toBeLessThan(334 * 5 + 10);
  });

  it("trips the same way however the stream is split into deltas", () => {
    const text = variedReasoning(50) + "Hmm, hmm. ".repeat(1_000);
    const one = replay(text, { diversity: true }, 1);
    const big = replay(text, { diversity: true }, 4_096);
    expect(one).toEqual(big);
    expect(one?.rule).toBe("repeated-unit");
  });

  it("trips on a paragraph cycle the repeated-unit rule cannot see (low diversity)", () => {
    const paragraph =
      "Let me reconsider whether the change was made at the required location in the schedule, " +
      "because the criterion names that exact place and the edit sits one row lower than it should.\n";
    const text = variedReasoning(100) + paragraph.repeat(60);
    expect(replay(text)).toMatchObject({ rule: "low-diversity" });
    // Content has no diversity rule.
    expect(replay(text, { diversity: false })).toBeUndefined();
  });

  it("trips on an indecision cycle that replays long passages of earlier reasoning", () => {
    // A ~2.5k-char block of varied reasoning, replayed again and again with a
    // one-line flip in between: too long a period for the repeated-unit rule,
    // too varied inside a 3,000-char window for the low-diversity rule.
    const block = variedReasoning(40, 11);
    const flips = ["So FAIL. Final.", "Hmm, but let me reconsider.", "OK, PASS? No.", "Wait, again."];
    const cycle = Array.from({ length: 12 }, (_, i) => `${block}\n${flips[i % flips.length]}\n`).join("");
    const text = variedReasoning(300, 5) + "\n" + cycle;
    expect(diversity(foldForRepetition(block).slice(0, 3_000))).toBeGreaterThan(0.5);
    const trip = replay(text);
    expect(trip).toMatchObject({ rule: "recycled" });
    expect(trip!.recycled!).toBeGreaterThanOrEqual(0.95);
  });

  it("does not trip when reasoning quotes the same passage a few times", () => {
    const passage = variedReasoning(12, 21);
    const text = [variedReasoning(200, 1), passage, variedReasoning(200, 2), passage, variedReasoning(200, 3), passage].join("\n");
    expect(replay(text)).toBeUndefined();
  });

  it("does not trip on long, varied reasoning", () => {
    const text = variedReasoning(6_000, 7);
    expect(text.length).toBeGreaterThan(400_000);
    expect(replay(text)).toBeUndefined();
  });

  it("does not trip on ~40 scattered 'Hmm's or on a healthy burst of them", () => {
    const parts = variedReasoning(400, 3).split(". ");
    const scattered = parts.map((s, i) => (i % 10 === 0 ? `${s}. Hmm` : s)).join(". ");
    expect(scattered.match(/Hmm\b/g)!.length).toBeGreaterThanOrEqual(40);
    expect(replay(scattered)).toBeUndefined();
    // Longest run seen in healthy judge reasoning was ~38 in a row; a draw
    // that still reached a verdict hit 138. Both stay well under the bound.
    expect(replay(variedReasoning(50) + "Hmm. ".repeat(40) + variedReasoning(50, 2))).toBeUndefined();
    expect(replay(variedReasoning(50) + "Hmm, hmm. ".repeat(69) + variedReasoning(50, 2))).toBeUndefined();
  });

  it("does not trip on a markdown table", () => {
    const rows = Array.from(
      { length: 400 },
      (_, i) => `| Row ${i + 1} | yes | yes | no | ${i % 3 === 0 ? "n/a" : "ok"} |`,
    );
    const table = `| Item | A | B | C | Note |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
    expect(replay(variedReasoning(20) + table + variedReasoning(20, 2))).toBeUndefined();
  });

  it("does not trip on a JSON blob", () => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      status: i % 4 === 0 ? "pending" : "active",
      owner: "team-a",
      tags: ["x", "y"],
      updated: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    const pretty = JSON.stringify(records, null, 2);
    const compact = JSON.stringify(records);
    expect(replay(variedReasoning(10) + pretty)).toBeUndefined();
    expect(replay(variedReasoning(10) + compact)).toBeUndefined();
    expect(replay(compact, { diversity: false })).toBeUndefined();
  });

  it("measures diversity as distinct / total 24-grams", () => {
    expect(diversity("ab".repeat(100))).toBeLessThan(0.02);
    expect(diversity(foldForRepetition(variedReasoning(200)).slice(0, 3_000))).toBeGreaterThan(0.5);
  });
});
