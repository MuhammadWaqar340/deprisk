import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { detectLockfiles, requireLockfileForLatest } from "../src/lockfileDetect.js";
import { readPnpmLockVersions } from "../src/versionDetect.js";
import { listLockedPackagesForLatestAudit } from "../src/scan.js";
import {
  loadDepRiskConfig,
  validateDepRiskConfig,
  mergeConfig,
} from "../src/config.js";
import { formatScanSarif } from "../src/sarifFormat.js";
import { formatScanSummary } from "../src/reportFormat.js";
import { UntypedPackageError } from "../src/analysisErrors.js";
import type { RiskReport } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-p1-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

describe("detectLockfiles", () => {
  it("prefers pnpm when both npm and pnpm locks exist", () => {
    const dir = makeProject({
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const warnings: string[] = [];
    const detected = detectLockfiles(dir);
    expect(detected.primary?.kind).toBe("pnpm");
    expect(detected.warning).toContain("Multiple lockfiles");
    expect(detected.warning).toContain("pnpm-lock.yaml");
    void warnings;
  });

  it("errors clearly when no lockfile for --latest", () => {
    const dir = makeProject({ "package.json": "{}" });
    expect(() => requireLockfileForLatest(dir)).toThrow(/No lockfile found/);
  });
});

describe("readPnpmLockVersions / latest audit", () => {
  it("parses pnpm-lock packages keys", () => {
    const text = `
lockfileVersion: '9.0'
packages:
  /lodash@4.17.21:
    resolution: {integrity: sha512-x}
  /axios@0.27.2:
    resolution: {integrity: sha512-y}
`;
    const map = readPnpmLockVersions(text);
    expect(map.get("lodash")).toBe("4.17.21");
    expect(map.get("axios")).toBe("0.27.2");
  });

  it("lists direct deps from pnpm lock for --latest", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        dependencies: { lodash: "4.17.21" },
        devDependencies: { vite: "8.0.0" },
      }),
      "pnpm-lock.yaml": `
lockfileVersion: '9.0'
packages:
  /lodash@4.17.21:
    resolution: {integrity: sha512-x}
  /vite@8.0.0:
    resolution: {integrity: sha512-y}
  /transitive@1.0.0:
    resolution: {integrity: sha512-z}
`,
    });
    const list = listLockedPackagesForLatestAudit(dir);
    expect(list.map((x) => x.packageName).sort()).toEqual(["lodash", "vite"]);
    expect(list[0].lockfileKind).toBe("pnpm");
  });
});

describe(".depriskrc", () => {
  it("loads and validates config", () => {
    const dir = makeProject({
      ".depriskrc.json": JSON.stringify({ failOn: "medium", includeDev: false }),
    });
    expect(loadDepRiskConfig(dir)).toEqual({ failOn: "medium", includeDev: false });
  });

  it("rejects unknown keys", () => {
    expect(() => validateDepRiskConfig({ foo: 1 })).toThrow(/Unknown option/);
  });

  it("merges CLI over file over defaults", () => {
    const merged = mergeConfig(
      { includeDev: true, failOn: undefined as string | undefined },
      { includeDev: false, failOn: "high" },
      { failOn: "error" },
    );
    expect(merged.includeDev).toBe(false);
    expect(merged.failOn).toBe("error");
  });
});

describe("SKIPPED reporting", () => {
  it("shows SKIPPED separately from ERROR", () => {
    const text = formatScanSummary({
      mode: "latest",
      reports: [],
      upToDate: [],
      skipped: [
        {
          packageName: "@oxlint/binding-linux-x64",
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
          reason: "no-types",
          message: "no types",
        },
      ],
      errors: [{ packageName: "broken-pkg", message: "network fail" }],
      worstLevel: "LOW",
    });
    expect(text).toContain("SKIPPED:    1");
    expect(text).toContain("ERROR:      1");
    expect(text).toContain("Skipped (no TypeScript types");
    expect(text).toContain("Errors:");
    expect(text).toContain("broken-pkg");
  });
});

describe("SARIF", () => {
  it("emits valid SARIF 2.1 structure with rule ids and locations", () => {
    const report: RiskReport = {
      packageName: "zod",
      fromVersion: "3.0.0",
      toVersion: "4.0.0",
      level: "MEDIUM",
      flagged: [
        {
          name: "z",
          status: "changed",
          changeKind: "signature_changed",
          summary: "signature changed",
          usages: [{ filePath: "src/App.tsx", line: 12 }],
        },
      ],
      unusedChangeCount: 0,
    };
    const sarif = formatScanSarif({
      mode: "latest",
      reports: [report],
      worstLevel: "MEDIUM",
    });
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("deprisk-check");
    expect(sarif.runs[0].tool.driver.rules.some((r) => r.id === "DEP-RISK-MEDIUM")).toBe(true);
    expect(sarif.runs[0].results[0].ruleId).toBe("DEP-RISK-API-CHANGED");
    expect(sarif.runs[0].results[0].locations?.[0].physicalLocation.artifactLocation.uri).toBe(
      "src/App.tsx",
    );
    expect(sarif.runs[0].results[0].locations?.[0].physicalLocation.region?.startLine).toBe(12);
    expect(sarif.runs[0].results[0].properties?.packageName).toBe("zod");
  });
});

describe("UntypedPackageError", () => {
  it("is identifiable", () => {
    const err = new UntypedPackageError("pkg", "msg");
    expect(err.code).toBe("UNTYPED");
  });
});
