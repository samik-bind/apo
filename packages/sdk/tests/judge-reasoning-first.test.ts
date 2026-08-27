/**
 * Issue #163: reasoning-first is the DEFAULT judge response contract.
 *
 * With `response_format: json_object` the model emits keys in the order the
 * contract asks for them — verdict-first (`{"pass": ..., "reasoning": ...}`)
 * makes it commit before justifying. The #163 measurement (every judged run
 * on the main stack, 14 criteria × 3 samples per arm) flipped the default:
 * sound deliverables scored identically in both arms, while on a degenerate
 * deliverable verdict-first false-passed 3/3 with the one-word reasoning
 * "passed" and reasoning-first reasoned to the correct FAIL.
 *
 * `APO_JUDGE_VERDICT_FIRST=1` elicits the legacy arm for A/B measurement.
 *
 * Compatibility invariant under test: with the override unset, every
 * assembled prompt is byte-identical to the reasoning-first prompt — the
 * flip is total, not per-task.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callJudge } from "../src/agent-task/checks/judge.ts";

const VERDICT_FIRST_CONTRACT =
  'Respond with ONLY a JSON object: {"pass": true/false, "reasoning": "your reasoning"}';
const REASONING_FIRST_CONTRACT =
  'Respond with ONLY a JSON object: {"reasoning": "your reasoning", "pass": true/false}';

const judgeArgs = {
  values: ["the deliverable"],
  instruction: "Is it good?",
  model: "test/judge",
  baseURL: "https://judge.test/v1",
  apiKey: "secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubJudge(content: string): vi.Mock {
  const fetchMock = vi.fn(async () =>
    Response.json({ choices: [{ message: { content } }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function systemText(fetchMock: vi.Mock, call = 0): string {
  const body = fetchMock.mock.calls[call]?.[1]?.body as string;
  const parsed = JSON.parse(body) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const system = parsed.messages[0]!.content as Array<{ text: string }>;
  return system[0]!.text;
}

describe("judge response contract elicitation order (#163)", () => {
  it("override unset: default system prompt is byte-identical to the reasoning-first prompt", async () => {
    const fetchMock = stubJudge('{"reasoning": "ok", "pass": true}');
    await callJudge(judgeArgs);
    expect(systemText(fetchMock)).toBe(
      "You are an evaluation judge. Evaluate the given value(s) against the " +
        `instruction. ${REASONING_FIRST_CONTRACT}`,
    );
  });

  it("override on (1): default system prompt asks for the verdict first", async () => {
    vi.stubEnv("APO_JUDGE_VERDICT_FIRST", "1");
    const fetchMock = stubJudge('{"pass": true, "reasoning": "ok"}');
    await callJudge(judgeArgs);
    expect(systemText(fetchMock)).toBe(
      "You are an evaluation judge. Evaluate the given value(s) against the " +
        `instruction. ${VERDICT_FIRST_CONTRACT}`,
    );
  });

  it("override on (true, any case): accepted", async () => {
    vi.stubEnv("APO_JUDGE_VERDICT_FIRST", "TRUE");
    const fetchMock = stubJudge('{"pass": true, "reasoning": "ok"}');
    await callJudge(judgeArgs);
    expect(systemText(fetchMock)).toContain(VERDICT_FIRST_CONTRACT);
  });

  it.each(["0", "false", "garbage", ""])(
    "override %s: stays reasoning-first",
    async (value) => {
      vi.stubEnv("APO_JUDGE_VERDICT_FIRST", value);
      const fetchMock = stubJudge('{"reasoning": "ok", "pass": true}');
      await callJudge(judgeArgs);
      expect(systemText(fetchMock)).toContain(REASONING_FIRST_CONTRACT);
    },
  );

  it("override on: the SDK-owned contract after a custom briefing flips too", async () => {
    vi.stubEnv("APO_JUDGE_VERDICT_FIRST", "1");
    const fetchMock = stubJudge('{"pass": true, "reasoning": "ok"}');
    await callJudge({
      ...judgeArgs,
      prompt: () => ({ system: "Custom briefing.", user: "Custom user." }),
    });
    const system = systemText(fetchMock);
    expect(system).toBe(`Custom briefing.\n\n${VERDICT_FIRST_CONTRACT}`);
    const body = fetchMock.mock.calls[0]?.[1]?.body as string;
    expect(JSON.parse(body).messages[1].content).toBe("Custom user.");
  });

  it("records which contract elicited the response in judge metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ choices: [{ message: { content: '{"reasoning": "ok", "pass": true}' } }] }),
      ),
    );
    const reasoningFirst = await callJudge({ ...judgeArgs, values: ["a"] });
    expect(reasoningFirst.judge.contract).toBe("reasoning-first");

    vi.stubEnv("APO_JUDGE_VERDICT_FIRST", "1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ choices: [{ message: { content: '{"pass": false, "reasoning": "because not"}' } }] }),
      ),
    );
    const verdictFirst = await callJudge({ ...judgeArgs, values: ["a"] });
    expect(verdictFirst.judge.contract).toBe("verdict-first");
  });

  describe("parser stays key-order tolerant regardless of the contract", () => {
    it("default (reasoning-first): verdict-first JSON still parses (tolerance pinned)", async () => {
      const fetchMock = stubJudge('{"pass": false, "reasoning": "because not"}');
      const result = await callJudge(judgeArgs);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toBe("because not");
      expect(systemText(fetchMock)).toContain(REASONING_FIRST_CONTRACT);
    });

    it("override on (verdict-first): reasoning-first JSON still parses (tolerance pinned)", async () => {
      vi.stubEnv("APO_JUDGE_VERDICT_FIRST", "1");
      stubJudge('{"reasoning": "because", "pass": true}');
      const result = await callJudge(judgeArgs);
      expect(result.pass).toBe(true);
      expect(result.reasoning).toBe("because");
    });
  });
});
