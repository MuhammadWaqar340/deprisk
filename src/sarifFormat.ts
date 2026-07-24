import fs from "node:fs";
import type { RiskReport } from "./types.js";
import type { ScanResult } from "./scan.js";

/** Minimal SARIF 2.1.0 document. Structurally validated by validateSarifLog; verify Code Scanning upload in your CI. */
export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      version?: string;
      informationUri?: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription?: { text: string };
  defaultConfiguration?: { level: "error" | "warning" | "note" };
  helpUri?: string;
  properties?: { tags?: string[] };
}

interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
  properties?: Record<string, string | number | boolean>;
}

const RULES: SarifRule[] = [
  {
    id: "DEP-RISK-HIGH",
    shortDescription: { text: "High dependency upgrade risk" },
    fullDescription: {
      text: "A used export was removed or multiple used exports changed between versions.",
    },
    defaultConfiguration: { level: "error" },
    properties: { tags: ["security", "dependency"] },
  },
  {
    id: "DEP-RISK-MEDIUM",
    shortDescription: { text: "Medium dependency upgrade risk" },
    fullDescription: {
      text: "Exactly one used export changed between versions.",
    },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["dependency"] },
  },
  {
    id: "DEP-RISK-API-REMOVED",
    shortDescription: { text: "Used API removed" },
    defaultConfiguration: { level: "error" },
  },
  {
    id: "DEP-RISK-API-CHANGED",
    shortDescription: { text: "Used API signature changed" },
    defaultConfiguration: { level: "warning" },
  },
];

export function formatScanSarif(
  result: Pick<ScanResult, "reports" | "mode" | "worstLevel">,
  options: { toolVersion?: string } = {},
): SarifLog {
  const results: SarifResult[] = [];

  for (const report of result.reports) {
    if (report.level === "LOW" && report.flagged.length === 0) continue;

    if (report.flagged.length === 0 && (report.level === "HIGH" || report.level === "MEDIUM")) {
      results.push(packageLevelResult(report));
      continue;
    }

    for (const entry of report.flagged) {
      const ruleId =
        entry.status === "removed" || entry.changeKind === "removed"
          ? "DEP-RISK-API-REMOVED"
          : entry.changeKind
            ? "DEP-RISK-API-CHANGED"
            : report.level === "HIGH"
              ? "DEP-RISK-HIGH"
              : "DEP-RISK-MEDIUM";

      const level =
        report.level === "HIGH" || entry.status === "removed" ? "error" : "warning";

      if (entry.usages.length === 0) {
        results.push({
          ruleId,
          level,
          message: {
            text:
              `${report.packageName} ${report.fromVersion} → ${report.toVersion}: `
              + `${entry.name}() — ${entry.summary}`,
          },
          properties: {
            packageName: report.packageName,
            fromVersion: report.fromVersion,
            toVersion: report.toVersion,
            riskLevel: report.level,
            exportName: entry.name,
            changeKind: entry.changeKind ?? entry.status,
            ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
            ...(entry.confidence ? { confidence: entry.confidence } : {}),
            ...(report.compatibility ? { reportCompatibility: report.compatibility } : {}),
          },
        });
        continue;
      }

      for (const usage of entry.usages) {
        results.push({
          ruleId,
          level,
          message: {
            text:
              `${report.packageName} ${report.fromVersion} → ${report.toVersion}: `
              + `${entry.name}() — ${entry.summary}`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: toSarifUri(usage.filePath) },
                region: { startLine: Math.max(1, usage.line) },
              },
            },
          ],
          properties: {
            packageName: report.packageName,
            fromVersion: report.fromVersion,
            toVersion: report.toVersion,
            riskLevel: report.level,
            exportName: entry.name,
            changeKind: entry.changeKind ?? entry.status,
            ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
            ...(entry.confidence ? { confidence: entry.confidence } : {}),
            ...(report.compatibility ? { reportCompatibility: report.compatibility } : {}),
          },
        });
      }
    }
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "deprisk-check",
            version: options.toolVersion ?? "0.9.0",
            informationUri: "https://www.npmjs.com/package/deprisk-check",
            rules: RULES,
          },
        },
        results,
      },
    ],
  };
}

function packageLevelResult(report: RiskReport): SarifResult {
  return {
    ruleId: report.level === "HIGH" ? "DEP-RISK-HIGH" : "DEP-RISK-MEDIUM",
    level: report.level === "HIGH" ? "error" : "warning",
    message: {
      text:
        `${report.packageName} ${report.fromVersion} → ${report.toVersion} `
        + `scored ${report.level} risk.`,
    },
    properties: {
      packageName: report.packageName,
      fromVersion: report.fromVersion,
      toVersion: report.toVersion,
      riskLevel: report.level,
    },
  };
}

function toSarifUri(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function writeSarifFile(filePath: string, log: SarifLog): void {
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2), "utf8");
}

/**
 * Validate a SARIF log against SARIF 2.1.0 structural requirements for documents
 * DepRisk emits. Throws with an actionable message on failure.
 *
 * This is a structural validator for the fields we produce (not a full OASIS
 * schema download). It is sufficient to catch malformed exports before CI upload.
 */
export function validateSarifLog(log: unknown): asserts log is SarifLog {
  if (!log || typeof log !== "object") {
    throw new Error("SARIF validation failed: root must be an object.");
  }
  const doc = log as Record<string, unknown>;
  if (doc.version !== "2.1.0") {
    throw new Error(
      `SARIF validation failed: version must be "2.1.0" (got ${JSON.stringify(doc.version)}).`,
    );
  }
  if (!Array.isArray(doc.runs) || doc.runs.length < 1) {
    throw new Error("SARIF validation failed: runs must be a non-empty array.");
  }
  for (const [i, run] of doc.runs.entries()) {
    if (!run || typeof run !== "object") {
      throw new Error(`SARIF validation failed: runs[${i}] must be an object.`);
    }
    const r = run as Record<string, unknown>;
    const tool = r.tool as Record<string, unknown> | undefined;
    const driver = tool?.driver as Record<string, unknown> | undefined;
    if (!driver || typeof driver.name !== "string") {
      throw new Error(`SARIF validation failed: runs[${i}].tool.driver.name is required.`);
    }
    if (!Array.isArray(driver.rules)) {
      throw new Error(`SARIF validation failed: runs[${i}].tool.driver.rules must be an array.`);
    }
    for (const [ri, rule] of (driver.rules as unknown[]).entries()) {
      const ruleObj = rule as Record<string, unknown>;
      if (typeof ruleObj?.id !== "string") {
        throw new Error(`SARIF validation failed: rules[${ri}].id is required.`);
      }
      const short = ruleObj.shortDescription as Record<string, unknown> | undefined;
      if (typeof short?.text !== "string") {
        throw new Error(`SARIF validation failed: rules[${ri}].shortDescription.text is required.`);
      }
    }
    if (!Array.isArray(r.results)) {
      throw new Error(`SARIF validation failed: runs[${i}].results must be an array.`);
    }
    for (const [ji, result] of (r.results as unknown[]).entries()) {
      const res = result as Record<string, unknown>;
      if (typeof res.ruleId !== "string") {
        throw new Error(`SARIF validation failed: results[${ji}].ruleId is required.`);
      }
      if (!["error", "warning", "note", "none"].includes(String(res.level))) {
        throw new Error(`SARIF validation failed: results[${ji}].level is invalid.`);
      }
      const message = res.message as Record<string, unknown> | undefined;
      if (typeof message?.text !== "string") {
        throw new Error(`SARIF validation failed: results[${ji}].message.text is required.`);
      }
      if (res.locations !== undefined) {
        if (!Array.isArray(res.locations)) {
          throw new Error(`SARIF validation failed: results[${ji}].locations must be an array.`);
        }
        for (const [li, loc] of (res.locations as unknown[]).entries()) {
          const physical = (loc as Record<string, unknown>)?.physicalLocation as
            | Record<string, unknown>
            | undefined;
          const artifact = physical?.artifactLocation as Record<string, unknown> | undefined;
          if (typeof artifact?.uri !== "string") {
            throw new Error(
              `SARIF validation failed: results[${ji}].locations[${li}].physicalLocation.artifactLocation.uri is required.`,
            );
          }
          if (physical?.region !== undefined) {
            const region = physical.region as Record<string, unknown>;
            if (typeof region.startLine !== "number" || region.startLine < 1) {
              throw new Error(
                `SARIF validation failed: results[${ji}].locations[${li}].region.startLine must be >= 1.`,
              );
            }
          }
        }
      }
    }
  }
}
