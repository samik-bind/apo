import type { CheckResult } from "@/lib/agent-task-api";

/**
 * One segment of the checks list after `describe()` grouping.
 *
 * - ``"check"`` — a bare check, declared outside any describe.
 * - ``"group"`` — a collapsible group of checks that shared one describe id.
 *
 * Segments are emitted in declaration order: a group segment appears at the
 * position of its first member check, so a bare check between two groups
 * renders between them. This keeps the list faithful to how the author wrote
 * it while letting the dashboard collapse a generated family (e.g. 34
 * ``R-00…R-33`` checks) under one roll-up header.
 */
export type CheckSegment =
  | { kind: "check"; check: CheckResult }
  | { kind: "group"; groupId: string; groupName: string; checks: CheckResult[] };

/**
 * Partition a flat ``checks_json`` list into ordered segments keyed off each
 * check's optional ``group_id``. Pure and stable — does not mutate the input.
 */
export function groupChecksByDescribe(checks: CheckResult[]): CheckSegment[] {
  const segments: CheckSegment[] = [];
  const groupIndex = new Map<string, number>();

  for (const check of checks) {
    const groupId = check.group_id;
    if (!groupId) {
      segments.push({ kind: "check", check });
      continue;
    }
    const existing = groupIndex.get(groupId);
    if (existing !== undefined) {
      const group = segments[existing] as Extract<CheckSegment, { kind: "group" }>;
      group.checks.push(check);
    } else {
      groupIndex.set(groupId, segments.length);
      segments.push({
        kind: "group",
        groupId,
        groupName: check.group_name ?? groupId,
        checks: [check],
      });
    }
  }
  return segments;
}

/** Roll-up pass/failed/total tally for a group's checks. */
export function groupVerdict(checks: CheckResult[]): {
  passed: number;
  failed: number;
  total: number;
} {
  const total = checks.length;
  const passed = checks.filter((c) => c.pass === true).length;
  return { passed, failed: total - passed, total };
}

/**
 * Sum judge costs across a group's checks. Sums from ``assertions[].judge.cost``
 * when assertions are present (the per-call truth), falling back to the
 * top-level ``check.judge.cost`` only when assertions are absent — so a check
 * is never double-counted.
 */
export function groupCost(checks: CheckResult[]): number {
  let sum = 0;
  for (const check of checks) {
    const assertions = check.assertions;
    if (assertions && assertions.length > 0) {
      for (const a of assertions) {
        if (typeof a.judge?.cost === "number") sum += a.judge.cost;
      }
    } else if (typeof check.judge?.cost === "number") {
      sum += check.judge.cost;
    }
  }
  return sum;
}
