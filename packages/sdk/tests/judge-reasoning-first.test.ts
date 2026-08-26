/**
 * Issue #163: reasoning-first judge response contract, behind an opt-in flag.
 *
 * With `response_format: json_object` the model emits keys in the order the
 * contract asks for them — verdict-first (`{"pass": ..., "reasoning": ...}`)
 * makes it commit before justifying. Reasoning-first is the better default,
 * but it changes every existing score, so it ships behind a process-wide
 * opt-in (`APO_JUDGE_REASONING_FIRST`) until measured (#163 measurement plan).
 *
 * Compatibility invariant under test: with the flag unset, every assembled
 * prompt is byte-identical to the pre-#163 prompt — no existing score moves.
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
  it("flag unset: default system prompt is byte-identical to the verdict-first prompt", async () => {
    const fetchMock = stubJudge('{"pass": true, "reasoning": "ok"}');
    await callJudge(judgeArgs);
    expect(systemText(fetchMock)).toBe(
      "You are an evaluation judge. Evaluate the given value(s) against the " +
      `instruction. ${VERDICT_FIRST_CONTRACT}`,
    );
  });

  it("flag on (1): default system prompt asks for reasoning first", async () => {
    vi.stubEnv("APO_JUDGE_REASONING_FIRST", "1");
    const fetchMock = stubJudge('{"reasoning": "ok", "pass": true}');
    await callJudge(judgeArgs);
    expect(systemText(fetchMock)).toBe(
      "You are an evaluation judge. Evaluate the given value(s) against the " +
      `instruction. ${REASONING_FIRST_CONTRACT}`,
    );
  });

  it("flag on (true, any case): accepted", async () => {
    vi.stubEnv("APO_JUDGE_REASONING_FIRST", "TRUE");
    const fetchMock = stubJudge('{"reasoning": "ok", "pass": true}');
    await callJudge(judgeArgs);
    expect(systemText(fetchMock)).toContain(REASONING_FIRST_CONTRACT);
  });

  it.each(["0", "false", "garbage", ""])(
    "flag %s: stays verdict-first",
    async (value) => {
      vi.stubEnv("APO_JUDGE_REASONING_FIRST", value);
      const fetchMock = stubJudge('{"pass": true, "reasoning": "ok"}');
      await callJudge(judgeArgs);
      expect(systemText(fetchMock)).toContain(VERDICT_FIRST_CONTRACT);
    },
  );

  it("flag on: the SDK-owned contract after a custom briefing flips too", async () => {
    vi.stubEnv("APO_JUDGE_REASONING_FIRST", "1");
    const fetchMock = stubJudge('{"reasoning": "ok", "pass": true}');
    await callJudge({
      ...judgeArgs,
      prompt: () => ({ system: "Custom briefing.", user: "Custom user." }),
    });
    const system = systemText(fetchMock);
    expect(system).toBe(`Custom briefing.\n\n${REASONING_FIRST_CONTRACT}`);
    const body = fetchMock.mock.calls[0]?.[1]?.body as string;
    expect(JSON.parse(body).messages[1].content).toBe("Custom user.");
  });

  it("records which contract elicited the response in judge metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ choices: [{ message: { content: '{"pass": true, "reasoning": "ok"}' } }] }),
      ),
    );
    const verdictFirst = await callJudge({ ...judgeArgs, values: ["a"] });
    expect(verdictFirst.judge.contract).toBe("verdict-first");

    vi.stubEnv("APO_JUDGE_REASONING_FIRST", "1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ choices: [{ message: { content: '{"reasoning": "ok", "pass": false}' } }] }),
      ),
    );
    const reasoningFirst = await callJudge({ ...judgeArgs, values: ["a"] });
    expect(reasoningFirst.judge.contract).toBe("reasoning-first");
  });

  describe("parser stays key-order tolerant regardless of the flag", () => {
    it("flag off: reasoning-first JSON still parses (tolerance pinned)", async () => {
      const fetchMock = stubJudge('{"reasoning": "because", "pass": true}');
      const result = await callJudge(judgeArgs);
      expect(result.pass).toBe(true);
      expect(result.reasoning).toBe("because");
      expect(systemText(fetchMock)).toContain(VERDICT_FIRST_CONTRACT);
    });

    it("flag on: verdict-first JSON still parses (tolerance pinned)", async () => {
      vi.stubEnv("APO_JUDGE_REASONING_FIRST", "1");
      stubJudge('{"pass": false, "reasoning": "because not"}');
      const result = await callJudge(judgeArgs);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toBe("because not");
    });
  });
});
