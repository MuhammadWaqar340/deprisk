import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { extractApiSurface, diffExtractedSurfaces } from "../src/apiDiff.js";
import { scanPackageUsage } from "../src/usageScanner.js";
import { analyzeCompatibility } from "../src/compatibility.js";
import { scoreRisk } from "../src/riskScorer.js";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures/compat/param-removed");

describe("Phase 2 performance smoke", () => {
  it("analyzes a small fixture in under 5s", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "deprisk-perf-"));
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.copyFileSync(
      path.join(fixtures, "src/compatible.ts"),
      path.join(projectDir, "src/compatible.ts"),
    );

    const start = performance.now();
    const oldSymbols = extractApiSurface(path.join(fixtures, "old/index.d.ts"));
    const newSymbols = extractApiSurface(path.join(fixtures, "new/index.d.ts"));
    const diff = diffExtractedSurfaces(oldSymbols, newSymbols);
    const usage = scanPackageUsage(projectDir, "compat-pkg");
    const compat = analyzeCompatibility({ diff, usage, oldSymbols, newSymbols });
    scoreRisk({
      packageName: "compat-pkg",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      diff,
      usage,
      compat,
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(compat.findings.length).toBeGreaterThan(0);
  });
});
