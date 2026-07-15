import { describe, it, expect } from "vitest";
import { scoreRisk } from "../src/riskScorer.js";
import type { ApiDiffEntry, UsageMap } from "../src/types.js";

const baseDiff: ApiDiffEntry[] = [
  {
    name: "merge",
    status: "changed",
    oldSignature: "function merge(a: object, b: object): object",
    newSignature: "function merge(a: object, b: object, opts?: object): object",
  },
  {
    name: "get",
    status: "changed",
    oldSignature: "function get(obj: object, path: string, defaultValue?: unknown): unknown",
    newSignature: "function get(obj: object, path: string): unknown",
  },
  {
    name: "map",
    status: "unchanged",
    oldSignature: "function map(): void",
    newSignature: "function map(): void",
  },
  {
    name: "flatten",
    status: "added",
    newSignature: "function flatten(arr: unknown[]): unknown[]",
  },
  {
    name: "omit",
    status: "changed",
    oldSignature: "function omit(obj: object, keys: string[]): object",
    newSignature: "function omit(obj: object, keys: string[]): object",
    deprecated: true,
  },
  {
    name: "pluck",
    status: "removed",
    oldSignature: "function pluck(arr: object[], key: string): unknown[]",
  },
];

describe("scoreRisk", () => {
  it("returns HIGH when 2+ used exports changed", () => {
    const usage: UsageMap = {
      merge: [{ filePath: "src/a.ts", line: 4 }],
      get: [{ filePath: "src/b.ts", line: 10 }],
    };

    const report = scoreRisk({
      packageName: "lodash",
      fromVersion: "4.0.0",
      toVersion: "5.0.0",
      diff: baseDiff,
      usage,
    });

    expect(report.level).toBe("HIGH");
    expect(report.flagged.map((f) => f.name).sort()).toEqual(["get", "merge"]);
    expect(report.unusedChangeCount).toBeGreaterThanOrEqual(1);
  });

  it("returns HIGH when a used export is removed", () => {
    const usage: UsageMap = {
      pluck: [{ filePath: "src/a.ts", line: 2 }],
    };

    const report = scoreRisk({
      packageName: "lodash",
      fromVersion: "4.0.0",
      toVersion: "5.0.0",
      diff: baseDiff,
      usage,
    });

    expect(report.level).toBe("HIGH");
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].status).toBe("removed");
    expect(report.flagged[0].summary).toBe("export removed");
  });

  it("returns MEDIUM when exactly one used export changed", () => {
    const usage: UsageMap = {
      merge: [{ filePath: "src/a.ts", line: 4 }],
    };

    const report = scoreRisk({
      packageName: "lodash",
      fromVersion: "4.0.0",
      toVersion: "5.0.0",
      diff: baseDiff,
      usage,
    });

    expect(report.level).toBe("MEDIUM");
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].name).toBe("merge");
  });

  it("returns LOW when no used exports were touched", () => {
    const usage: UsageMap = {
      map: [{ filePath: "src/a.ts", line: 1 }],
    };

    const report = scoreRisk({
      packageName: "lodash",
      fromVersion: "4.0.0",
      toVersion: "5.0.0",
      diff: baseDiff,
      usage,
    });

    expect(report.level).toBe("LOW");
    expect(report.flagged).toHaveLength(0);
    expect(report.unusedChangeCount).toBeGreaterThan(0);
  });

  it("returns LOW with notImported when usage map is empty", () => {
    const report = scoreRisk({
      packageName: "lodash",
      fromVersion: "4.0.0",
      toVersion: "5.0.0",
      diff: baseDiff,
      usage: {},
    });

    expect(report.level).toBe("LOW");
    expect(report.notImported).toBe(true);
    expect(report.flagged).toHaveLength(0);
  });

  it("attaches usage locations to flagged entries", () => {
    const usage: UsageMap = {
      get: [
        { filePath: "src/a.ts", line: 4 },
        { filePath: "src/b.ts", line: 8 },
      ],
    };

    const report = scoreRisk({
      packageName: "lodash",
      fromVersion: "4.0.0",
      toVersion: "5.0.0",
      diff: baseDiff,
      usage,
    });

    expect(report.flagged[0].usages).toHaveLength(2);
    expect(report.flagged[0].usages[0].filePath).toBe("src/a.ts");
  });
});
