import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { extractApiSurface, diffExtractedSurfaces } from "../src/apiDiff.js";
import { scanPackageUsage } from "../src/usageScanner.js";
import { analyzeCompatibility } from "../src/compatibility.js";
import { scoreRisk } from "../src/riskScorer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures/compat");
const PKG = "compat-pkg";

function analyzeFixture(
  name: string,
  srcFile: string,
  options: { followReexports?: boolean; alsoCopy?: string[] } = {},
) {
  const root = path.join(fixtures, name);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `deprisk-compat-${name}-`));
  const srcDir = path.join(projectDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.copyFileSync(path.join(root, "src", srcFile), path.join(srcDir, srcFile));
  for (const extra of options.alsoCopy ?? []) {
    fs.copyFileSync(path.join(root, "src", extra), path.join(srcDir, extra));
  }

  const oldSymbols = extractApiSurface(path.join(root, "old/index.d.ts"));
  const newSymbols = extractApiSurface(path.join(root, "new/index.d.ts"));
  const diff = diffExtractedSurfaces(oldSymbols, newSymbols);
  const usage = scanPackageUsage(projectDir, PKG, {
    followReexports: options.followReexports,
  });
  const compat = analyzeCompatibility({ diff, usage, oldSymbols, newSymbols });
  const report = scoreRisk({
    packageName: PKG,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    diff,
    usage,
    compat,
  });
  return { compat, report, usage, diff, projectDir };
}

describe("Phase 2 compatibility fixtures", () => {
  it("1a: param removed — 1-arg call is COMPATIBLE / LOW", () => {
    const { compat, report } = analyzeFixture("param-removed", "compatible.ts");
    expect(compat.compatibility).toBe("COMPATIBLE");
    expect(report.level).toBe("LOW");
    expect(compat.findings.some((f) => f.kind === "PARAM_REMOVED")).toBe(true);
  });

  it("1b: param removed — 2-arg call is INCOMPATIBLE / HIGH", () => {
    const { compat, report } = analyzeFixture("param-removed", "incompatible.ts");
    expect(compat.compatibility).toBe("INCOMPATIBLE");
    expect(report.level).toBe("HIGH");
  });

  it("2: required param added — under-arity INCOMPATIBLE / HIGH", () => {
    const { compat, report } = analyzeFixture("param-added-required", "usage.ts");
    expect(compat.compatibility).toBe("INCOMPATIBLE");
    expect(report.level).toBe("HIGH");
    expect(compat.findings.some((f) => f.kind === "PARAM_ADDED_REQUIRED")).toBe(true);
  });

  it("3: optional param added — COMPATIBLE / LOW", () => {
    const { compat, report } = analyzeFixture("param-added-optional", "usage.ts");
    expect(compat.compatibility).toBe("COMPATIBLE");
    expect(report.level).toBe("LOW");
  });

  it("4a: options property removed and used — INCOMPATIBLE / HIGH", () => {
    const { compat, report } = analyzeFixture("options-removed", "with-retries.ts");
    expect(compat.compatibility).toBe("INCOMPATIBLE");
    expect(report.level).toBe("HIGH");
    expect(compat.findings.some((f) => f.kind === "OPTIONS_PROP_REMOVED")).toBe(true);
  });

  it("4b: options property removed but unused — COMPATIBLE / LOW", () => {
    const { compat, report } = analyzeFixture("options-removed", "without-retries.ts");
    expect(compat.compatibility).toBe("COMPATIBLE");
    expect(report.level).toBe("LOW");
  });

  it("5a: return nullable with unsafe access — POTENTIALLY_INCOMPATIBLE / MEDIUM", () => {
    const { compat, report } = analyzeFixture("return-nullable", "unsafe.ts");
    expect(compat.compatibility).toBe("POTENTIALLY_INCOMPATIBLE");
    expect(report.level).toBe("MEDIUM");
  });

  it("5b: return nullable with null check — COMPATIBLE / LOW", () => {
    const { compat, report } = analyzeFixture("return-nullable", "safe.ts");
    expect(compat.compatibility).toBe("COMPATIBLE");
    expect(report.level).toBe("LOW");
  });

  it("6: removed method usage — INCOMPATIBLE / HIGH", () => {
    const { compat, report, usage } = analyzeFixture("method-removed", "usage.ts");
    expect(usage.createClient?.some((u) => u.propertyName === "cancel")).toBe(true);
    expect(compat.compatibility).toBe("INCOMPATIBLE");
    expect(report.level).toBe("HIGH");
  });

  it("7a: overload removed — string call COMPATIBLE", () => {
    const { compat, report } = analyzeFixture("overload", "ok.ts");
    expect(compat.compatibility).toBe("COMPATIBLE");
    expect(report.level).toBe("LOW");
  });

  it("7b: overload removed — number call INCOMPATIBLE", () => {
    const { compat, report } = analyzeFixture("overload", "bad.ts");
    expect(compat.compatibility).toBe("INCOMPATIBLE");
    expect(report.level).toBe("HIGH");
  });

  it("8: destructured removed property — INCOMPATIBLE / HIGH", () => {
    const { compat, report } = analyzeFixture("destructure", "usage.ts");
    expect(compat.compatibility).toBe("INCOMPATIBLE");
    expect(report.level).toBe("HIGH");
  });

  it("9: re-export barrel to call site — INCOMPATIBLE", () => {
    const { compat, report } = analyzeFixture("reexport", "app.ts", {
      followReexports: true,
      alsoCopy: ["lib.ts"],
    });
    expect(compat.compatibility).toBe("INCOMPATIBLE");
    expect(report.level).toBe("HIGH");
  });

  it("10: simple wrapper with compatible arity — COMPATIBLE / LOW", () => {
    const { compat, report } = analyzeFixture("wrapper", "usage.ts");
    expect(compat.compatibility).toBe("COMPATIBLE");
    expect(report.level).toBe("LOW");
  });

  it("11: generic constraint — not auto HIGH", () => {
    const { compat, report } = analyzeFixture("generic", "usage.ts");
    expect(compat.compatibility).not.toBe("INCOMPATIBLE");
    expect(report.level).not.toBe("HIGH");
    expect(["UNKNOWN", "POTENTIALLY_INCOMPATIBLE", "COMPATIBLE"]).toContain(compat.compatibility);
  });

  it("12: unknown dynamic usage — UNKNOWN, not HIGH", () => {
    const { compat, report } = analyzeFixture("unknown", "usage.ts");
    expect(report.level).not.toBe("HIGH");
    expect(["UNKNOWN", "COMPATIBLE", "POTENTIALLY_INCOMPATIBLE"]).toContain(compat.compatibility);
  });
});

describe("scoreRisk with compat evidence", () => {
  it("does not flag purely compatible changes as HIGH", () => {
    const { report } = analyzeFixture("param-removed", "compatible.ts");
    expect(report.level).toBe("LOW");
    expect(report.compatibleChangeCount).toBeGreaterThanOrEqual(1);
    expect(report.compatibility).toBe("COMPATIBLE");
    expect(report.findings?.length).toBeGreaterThan(0);
  });
});
