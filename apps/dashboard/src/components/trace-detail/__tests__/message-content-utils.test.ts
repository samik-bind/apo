import { describe, it, expect } from "vitest";
import {
  formatJsonMessageText,
  parseJsonPayload,
} from "../message-content-utils";

describe("parseJsonPayload", () => {
  it("returns the parsed object", () => {
    expect(parseJsonPayload('{"gist":"Termination","notes":[]}')).toEqual({
      gist: "Termination",
      notes: [],
    });
  });

  it("returns the parsed array", () => {
    expect(parseJsonPayload('[{"sev":"high"}]')).toEqual([{ sev: "high" }]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseJsonPayload('\n  {"a":1}\n')).toEqual({ a: 1 });
  });

  it("tolerates whitespace JSON itself doesn't allow", () => {
    // String.trim strips a superset of JSON's whitespace; a payload padded
    // with a BOM or a non-breaking space is still a payload.
    expect(parseJsonPayload('\uFEFF{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonPayload('\u00A0{"a":1}\u00A0')).toEqual({ a: 1 });
  });

  it("rejects prose", () => {
    expect(parseJsonPayload("I reviewed the agreement.")).toBeNull();
  });

  it("rejects prose that merely opens with a brace", () => {
    expect(parseJsonPayload("{placeholder} needs a value")).toBeNull();
  });

  it("rejects a fenced JSON block — markdown renders those itself", () => {
    expect(parseJsonPayload('```json\n{"a":1}\n```')).toBeNull();
  });

  it("rejects markdown link syntax", () => {
    expect(parseJsonPayload("[the report](https://example.com)")).toBeNull();
  });

  it("rejects structured output truncated mid-payload", () => {
    expect(parseJsonPayload('{"gist":"Termination","notes":[{"sev":')).toBeNull();
  });

  it("rejects JSON primitives — they read as prose", () => {
    expect(parseJsonPayload("42")).toBeNull();
    expect(parseJsonPayload("true")).toBeNull();
    expect(parseJsonPayload("null")).toBeNull();
    expect(parseJsonPayload('"quoted"')).toBeNull();
  });

  it("rejects the empty string", () => {
    expect(parseJsonPayload("")).toBeNull();
  });
});

describe("formatJsonMessageText", () => {
  it("indents an object two spaces", () => {
    expect(formatJsonMessageText('{"gist":"Termination","notes":[]}')).toBe(
      '{\n  "gist": "Termination",\n  "notes": []\n}',
    );
  });

  it("indents nested values", () => {
    expect(formatJsonMessageText('[{"sev":"high"}]')).toBe(
      '[\n  {\n    "sev": "high"\n  }\n]',
    );
  });

  it("passes non-payloads through as null", () => {
    expect(formatJsonMessageText("I reviewed the agreement.")).toBeNull();
    expect(formatJsonMessageText("42")).toBeNull();
  });
});
