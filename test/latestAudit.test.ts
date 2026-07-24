import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveLatestVersion,
  isStableVersion,
  compareSemverDesc,
} from "../src/latest.js";
import {
  listLockedPackagesForLatestAudit,
  resolveScanBumps,
  runScan,
  worstLevel,
} from "../src/scan.js";
import { formatScanSummary, formatScanMarkdown } from "../src/reportFormat.js";
import { generateWorkflowYaml } from "../src/init.js";
import type { RiskReport } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-latest-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const lockWithDeps = JSON.stringify({
  packages: {
    "": {},
    "node_modules/lodash": { version: "4.17.21" },
    "node_modules/axios": { version: "0.27.2" },
    "node_modules/vite": { version: "8.0.0" },
    "node_modules/oxlint": { version: "1.74.0" },
    "node_modules/transitive-lib": { version: "1.0.0" },
  },
});

describe("resolveLatestVersion / semver helpers", () => {
  it("detects stable versions", () => {
    expect(isStableVersion("1.2.3")).toBe(true);
    expect(isStableVersion("1.2.3-beta.1")).toBe(false);
  });

  it("sorts semver descending", () => {
    expect(["1.0.0", "1.2.0", "1.10.0"].sort(compareSemverDesc)).toEqual([
      "1.10.0",
      "1.2.0",
      "1.0.0",
    ]);
  });

  it("prefers stable latest dist-tag", async () => {
    const v = await resolveLatestVersion("demo-pkg", {
      fetchPackument: async () => ({
        "dist-tags": { latest: "2.0.0", next: "3.0.0-rc.1" },
        versions: {
          "1.0.0": {},
          "2.0.0": {},
          "3.0.0-rc.1": {},
        },
      }),
    });
    expect(v).toBe("2.0.0");
  });

  it("falls back to highest stable when latest tag is prerelease", async () => {
    const v = await resolveLatestVersion("demo-pkg", {
      fetchPackument: async () => ({
        "dist-tags": { latest: "3.0.0-beta.1" },
        versions: {
          "1.0.0": {},
          "2.1.0": {},
          "3.0.0-beta.1": {},
        },
      }),
    });
    expect(v).toBe("2.1.0");
  });
});

describe("listLockedPackagesForLatestAudit", () => {
  it("defaults to direct deps from package.json with lock versions", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        dependencies: { lodash: "^4.17.21", axios: "^0.27.0" },
        devDependencies: { oxlint: "^1.74.0" },
      }),
      "package-lock.json": lockWithDeps,
    });

    const list = listLockedPackagesForLatestAudit(dir);
    expect(list.map((x) => x.packageName).sort()).toEqual([
      "axios",
      "lodash",
      "oxlint",
    ]);
    expect(list.find((x) => x.packageName === "lodash")?.lockedVersion).toBe("4.17.21");
  });

  it("supports --all for every top-level lock entry", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ dependencies: { lodash: "4.17.21" } }),
      "package-lock.json": lockWithDeps,
    });

    const list = listLockedPackagesForLatestAudit(dir, { all: true });
    expect(list.map((x) => x.packageName)).toContain("transitive-lib");
    expect(list.map((x) => x.packageName)).toContain("vite");
  });

  it("supports --no-include-dev", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        dependencies: { lodash: "4.17.21" },
        devDependencies: { oxlint: "1.74.0" },
      }),
      "package-lock.json": lockWithDeps,
    });

    const list = listLockedPackagesForLatestAudit(dir, { includeDev: false });
    expect(list.map((x) => x.packageName)).toEqual(["lodash"]);
  });
});

describe("runScan --latest", () => {
  it("marks up-to-date packages and records resolve errors", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        dependencies: { oxlint: "1.74.0", "missing-on-npm-xyz": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        packages: {
          "": {},
          "node_modules/oxlint": { version: "1.74.0" },
          "node_modules/missing-on-npm-xyz": { version: "1.0.0" },
        },
      }),
    });

    const result = await runScan({
      path: dir,
      latest: true,
      resolveLatest: async (name) => {
        if (name === "oxlint") return "1.74.0";
        throw new Error("not found on registry");
      },
    });

    expect(result.mode).toBe("latest");
    expect(result.upToDate).toEqual([{ packageName: "oxlint", version: "1.74.0" }]);
    expect(result.errors.some((e) => e.packageName === "missing-on-npm-xyz")).toBe(true);
    expect(result.reports).toHaveLength(0);
    expect(result.worstLevel).toBe("LOW");
  });

  it("rejects combining --latest with base-lock", async () => {
    await expect(
      runScan({ path: ".", latest: true, baseLock: "/tmp/x" }),
    ).rejects.toThrow(/not both/);
  });
});

describe("resolveScanBumps (PR mode still works)", () => {
  it("detects bumps from base vs head lock", () => {
    const dir = makeProject({
      "package-lock.json": JSON.stringify({
        packages: {
          "": {},
          "node_modules/lodash": { version: "4.18.1" },
        },
      }),
    });
    const base = path.join(dir, "base.json");
    fs.writeFileSync(
      base,
      JSON.stringify({
        packages: {
          "": {},
          "node_modules/lodash": { version: "4.17.21" },
        },
      }),
    );

    const bumps = resolveScanBumps({ path: dir, baseLock: base });
    expect(bumps).toEqual([
      { packageName: "lodash", fromVersion: "4.17.21", toVersion: "4.18.1" },
    ]);
  });
});

describe("formatScanSummary latest mode", () => {
  it("summarizes UP_TO_DATE by default and lists on --show-up-to-date", () => {
    const base = {
      mode: "latest" as const,
      reports: [
        {
          packageName: "lodash",
          fromVersion: "4.17.21",
          toVersion: "4.18.1",
          level: "LOW" as const,
          flagged: [],
          unusedChangeCount: 0,
        },
      ],
      upToDate: [{ packageName: "oxlint", version: "1.74.0" }],
      skipped: [],
      errors: [],
      worstLevel: "LOW" as const,
    };
    const text = formatScanSummary(base);
    expect(text).toContain("latest audit");
    expect(text).toContain("Summary");
    expect(text).toContain("UP_TO_DATE: 1");
    expect(text).toContain("already on latest");
    expect(text).not.toMatch(/oxlint\s+1\.74\.0\s+1\.74\.0\s+UP_TO_DATE/);

    const verbose = formatScanSummary({ ...base, showUpToDate: true });
    expect(verbose).toContain("UP_TO_DATE");
    expect(verbose).toContain("oxlint");
  });

  it("formats markdown with summary counts", () => {
    const md = formatScanMarkdown({
      mode: "latest",
      reports: [],
      upToDate: [{ packageName: "vite", version: "8.0.0" }],
      skipped: [],
      errors: [],
      worstLevel: "LOW",
    });
    expect(md).toContain("DepRisk Upgrade Analysis");
    expect(md).toContain("UP_TO_DATE");
    expect(md).toContain("| Analyzed |");
  });
});

describe("worstLevel", () => {
  it("picks highest", () => {
    expect(worstLevel([{ level: "LOW" } as RiskReport, { level: "HIGH" } as RiskReport])).toBe(
      "HIGH",
    );
  });
});

describe("generateWorkflowYaml", () => {
  it("uses deprisk scan", () => {
    const yaml = generateWorkflowYaml({ packageVersion: "0.8.0" });
    expect(yaml).toContain("deprisk scan");
    expect(yaml).toContain("--base-lock");
  });
});
