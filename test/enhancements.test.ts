import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { diffNpmLockfiles, detectVersionBumps } from "../src/versionDetect.js";
import { loadIgnoreSet, filterIgnoredNames } from "../src/ignore.js";
import { formatMarkdownReport, formatHtmlReport } from "../src/reportFormat.js";
import { classifyChangeKind } from "../src/apiDiff.js";
import { scoreRisk, isMajorBump } from "../src/riskScorer.js";
import { scanPackageUsage, discoverWorkspaceRoots } from "../src/usageScanner.js";
import type { RiskReport } from "../src/types.js";

const tempDirs: string[] = [];

function makeTemp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-ph-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("diffNpmLockfiles", () => {
  it("detects version bumps between base and head locks", () => {
    const base = JSON.stringify({
      packages: {
        "": {},
        "node_modules/lodash": { version: "4.17.20" },
        "node_modules/vite": { version: "8.0.0" },
      },
    });
    const head = JSON.stringify({
      packages: {
        "": {},
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/vite": { version: "8.0.0" },
      },
    });

    const bumps = diffNpmLockfiles(base, head);
    expect(bumps).toEqual([
      { packageName: "lodash", fromVersion: "4.17.20", toVersion: "4.17.21" },
    ]);
  });
});

describe("detectVersionBumps", () => {
  it("reads pinned versions from package-lock.json", () => {
    const dir = makeTemp({
      "package-lock.json": JSON.stringify({
        packages: {
          "": {},
          "node_modules/vite": { version: "8.0.0" },
        },
      }),
    });
    const bumps = detectVersionBumps(dir, { packageName: "vite" });
    expect(bumps[0]).toMatchObject({
      packageName: "vite",
      toVersion: "8.0.0",
    });
  });
});

describe("ignore + reports", () => {
  it("loads .depriskignore", () => {
    const dir = makeTemp({
      ".depriskignore": `# comment\nmerge\nlodash:get\n`,
    });
    const set = loadIgnoreSet(dir, "lodash");
    expect(set.has("merge")).toBe(true);
    expect(set.has("get")).toBe(true);
  });

  it("filters ignored names", () => {
    const filtered = filterIgnoredNames(
      [{ name: "a" }, { name: "b" }],
      new Set(["a"]),
    );
    expect(filtered).toEqual([{ name: "b" }]);
  });

  it("formats markdown and html", () => {
    const report: RiskReport = {
      packageName: "lodash",
      fromVersion: "4.0.0",
      toVersion: "5.0.0",
      level: "HIGH",
      flagged: [
        {
          name: "merge",
          status: "changed",
          summary: "signature changed",
          usages: [{ filePath: "src/a.ts", line: 3 }],
        },
      ],
      unusedChangeCount: 2,
      typesSource: { old: "definitelyTyped", new: "definitelyTyped" },
    };
    const md = formatMarkdownReport(report);
    expect(md).toContain("HIGH");
    expect(md).toContain("merge");
    const html = formatHtmlReport(report);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("merge");
  });
});

describe("classifyChangeKind + semver", () => {
  it("classifies param removal", () => {
    expect(
      classifyChangeKind(
        "function get(a: object, b: string, c?: unknown): unknown",
        "function get(a: object, b: string): unknown",
        false,
        true,
      ),
    ).toBe("param_removed");
  });

  it("detects major bumps", () => {
    expect(isMajorBump("4.17.21", "5.0.0")).toBe(true);
    expect(isMajorBump("4.17.21", "4.18.0")).toBe(false);
  });

  it("applies semver weighting for removals on major bumps", () => {
    const report = scoreRisk({
      packageName: "x",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      semverWeighting: true,
      diff: [
        {
          name: "oldApi",
          status: "removed",
          oldSignature: "function oldApi(): void",
          changeKind: "removed",
        },
      ],
      usage: { oldApi: [{ filePath: "a.ts", line: 1 }] },
    });
    expect(report.level).toBe("HIGH");
  });
});

describe("barrel re-exports", () => {
  it("traces named re-exports through a local barrel", () => {
    const dir = makeTemp({
      "src/utils/index.ts": `
export { merge } from "lodash";
`,
      "src/app.ts": `
import { merge } from "./utils";
export const out = merge({ a: 1 }, { b: 2 });
`,
    });

    const usage = scanPackageUsage(dir, "lodash", { followReexports: true });
    expect(usage.merge).toBeDefined();
    expect(usage.merge.some((u) => u.filePath.includes("app.ts"))).toBe(true);
  });
});

describe("discoverWorkspaceRoots", () => {
  it("finds packages/* workspaces", () => {
    const dir = makeTemp({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/b/package.json": JSON.stringify({ name: "b" }),
    });
    const roots = discoverWorkspaceRoots(dir);
    expect(roots.length).toBe(2);
  });
});
