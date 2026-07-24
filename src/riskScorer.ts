import type {
  ApiDiffEntry,
  ChangeKind,
  CompatFinding,
  Compatibility,
  Confidence,
  FlaggedEntry,
  RiskLevel,
  RiskReport,
  TypesSource,
  UsageMap,
} from "./types.js";
import type { CompatibilityAnalysis } from "./compatibility.js";
import { compatibilityToRiskHint, worstCompatibility, bestConfidence } from "./compatibility.js";

export interface ScoreRiskInput {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  diff: ApiDiffEntry[];
  usage: UsageMap;
  typesSource?: { old: TypesSource; new: TypesSource };
  /** When true, a major-version bump with any removal escalates toward HIGH */
  semverWeighting?: boolean;
  /** Phase 2 deep compatibility analysis (when omitted, falls back to legacy count-based) */
  compat?: CompatibilityAnalysis;
}

/**
 * Cross-reference API diff entries with local usages to produce a risk report.
 *
 * Phase 2 (with compat):
 *   HIGH   — any INCOMPATIBLE finding (or used removal)
 *   MEDIUM — POTENTIALLY_INCOMPATIBLE or UNKNOWN used changes
 *   LOW    — only COMPATIBLE / NOT_USED
 *
 * Legacy (no compat): count-based HIGH/MEDIUM/LOW for backward-compatible unit tests.
 */
export function scoreRisk(input: ScoreRiskInput): RiskReport {
  if (input.compat) {
    return scoreWithCompat(input, input.compat);
  }
  return scoreLegacy(input);
}

function scoreWithCompat(input: ScoreRiskInput, compat: CompatibilityAnalysis): RiskReport {
  const { packageName, fromVersion, toVersion, diff, usage, typesSource } = input;
  const usedNames = new Set(Object.keys(usage));
  const notImported = usedNames.size === 0;

  const findings = compat.findings;
  const impactful = new Set(compat.impactfulSymbols);
  const compatibleSet = new Set(compat.compatibleSymbols);

  const flagged: FlaggedEntry[] = [];
  let unusedChangeCount = 0;
  let compatibleChangeCount = 0;

  for (const entry of diff) {
    if (entry.status !== "removed" && entry.status !== "changed") continue;
    const usages = usage[entry.name];
    if (!usages || usages.length === 0) {
      unusedChangeCount += 1;
      continue;
    }

    if (compatibleSet.has(entry.name) && !impactful.has(entry.name)) {
      compatibleChangeCount += 1;
      continue;
    }

    // Only flag when impactful or unknown (not purely compatible)
    const symbolFindings = findings.filter((f) => f.symbol === entry.name);
    const worst = worstCompatibility(symbolFindings.map((f) => f.compatibility));
    if (worst === "COMPATIBLE" || worst === "NOT_USED") {
      compatibleChangeCount += 1;
      continue;
    }

    const changeKind = entry.changeKind ?? inferChangeKind(entry);
    const primary = pickPrimaryFinding(symbolFindings);
    flagged.push({
      name: entry.name,
      status: entry.status,
      oldSignature: entry.oldSignature,
      newSignature: entry.newSignature,
      deprecated: entry.deprecated,
      changeKind,
      usages,
      summary: primary?.reason ?? summarizeChange(entry, changeKind),
      compatibility: worst,
      confidence: primary?.confidence ?? bestConfidence(symbolFindings.map((f) => f.confidence)),
      findings: symbolFindings,
    });
  }

  // Include impactful symbols discovered via secondary analysis (e.g. return-type methods)
  for (const name of compat.impactfulSymbols) {
    if (flagged.some((f) => f.name === name)) continue;
    const symbolFindings = findings.filter((f) => f.symbol === name);
    if (symbolFindings.length === 0) continue;
    const worst = worstCompatibility(symbolFindings.map((f) => f.compatibility));
    if (worst === "COMPATIBLE" || worst === "NOT_USED") continue;
    const entry = diff.find((d) => d.name === name);
    const primary = pickPrimaryFinding(symbolFindings);
    flagged.push({
      name,
      status: entry?.status === "removed" ? "removed" : "changed",
      oldSignature: entry?.oldSignature ?? primary?.oldSignature,
      newSignature: entry?.newSignature ?? primary?.newSignature,
      changeKind: entry?.changeKind ?? "signature_changed",
      usages: usage[name] ?? [],
      summary: primary?.reason ?? "compatibility impact detected",
      compatibility: worst,
      confidence: primary?.confidence ?? bestConfidence(symbolFindings.map((f) => f.confidence)),
      findings: symbolFindings,
    });
  }

  flagged.sort((a, b) => {
    if (a.status !== b.status) return a.status === "removed" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let level = computeLevelFromCompat(compat, flagged);
  if (input.semverWeighting) {
    level = applySemverWeighting(level, flagged, fromVersion, toVersion);
  }

  return {
    packageName,
    fromVersion,
    toVersion,
    level,
    flagged,
    unusedChangeCount,
    compatibleChangeCount,
    compatibility: compat.compatibility,
    confidence: compat.confidence,
    findings,
    ...(notImported ? { notImported: true } : {}),
    ...(typesSource ? { typesSource } : {}),
  };
}

function pickPrimaryFinding(findings: CompatFinding[]): CompatFinding | undefined {
  if (findings.length === 0) return undefined;
  return [...findings].sort(
    (a, b) =>
      rankCompat(b.compatibility) - rankCompat(a.compatibility)
      || rankConf(b.confidence) - rankConf(a.confidence),
  )[0];
}

function rankCompat(c: Compatibility): number {
  const order: Compatibility[] = [
    "NOT_USED",
    "COMPATIBLE",
    "UNKNOWN",
    "POTENTIALLY_INCOMPATIBLE",
    "INCOMPATIBLE",
  ];
  return order.indexOf(c);
}

function rankConf(c: Confidence): number {
  const order: Confidence[] = ["UNKNOWN", "LOW", "MEDIUM", "HIGH"];
  return order.indexOf(c);
}

function computeLevelFromCompat(
  compat: CompatibilityAnalysis,
  flagged: FlaggedEntry[],
): RiskLevel {
  const hasRemoval = flagged.some((f) => f.status === "removed")
    || compat.findings.some((f) => f.kind === "REMOVED" || f.kind === "METHOD_REMOVED");

  if (compat.compatibility === "INCOMPATIBLE") {
    return "HIGH";
  }
  if (compat.compatibility === "POTENTIALLY_INCOMPATIBLE") {
    return "MEDIUM";
  }
  if (compat.compatibility === "UNKNOWN") {
    // Never auto-HIGH on UNKNOWN alone
    return compatibilityToRiskHint("UNKNOWN", compat.confidence, hasRemoval);
  }
  if (flagged.length === 0) return "LOW";
  return compatibilityToRiskHint(compat.compatibility, compat.confidence, hasRemoval);
}

function scoreLegacy(input: ScoreRiskInput): RiskReport {
  const { packageName, fromVersion, toVersion, diff, usage, typesSource } = input;
  const usedNames = new Set(Object.keys(usage));
  const notImported = usedNames.size === 0;

  const flagged: FlaggedEntry[] = [];
  let unusedChangeCount = 0;

  for (const entry of diff) {
    if (entry.status !== "removed" && entry.status !== "changed") {
      continue;
    }

    const usages = usage[entry.name];
    if (!usages || usages.length === 0) {
      unusedChangeCount += 1;
      continue;
    }

    const changeKind = entry.changeKind ?? inferChangeKind(entry);
    flagged.push({
      name: entry.name,
      status: entry.status,
      oldSignature: entry.oldSignature,
      newSignature: entry.newSignature,
      deprecated: entry.deprecated,
      changeKind,
      usages,
      summary: summarizeChange(entry, changeKind),
    });
  }

  flagged.sort((a, b) => {
    if (a.status !== b.status) return a.status === "removed" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let level = computeLevelLegacy(flagged);

  if (input.semverWeighting) {
    level = applySemverWeighting(level, flagged, fromVersion, toVersion);
  }

  return {
    packageName,
    fromVersion,
    toVersion,
    level,
    flagged,
    unusedChangeCount,
    ...(notImported ? { notImported: true } : {}),
    ...(typesSource ? { typesSource } : {}),
  };
}

function computeLevelLegacy(flagged: FlaggedEntry[]): RiskLevel {
  if (flagged.length === 0) return "LOW";

  const hasRemoved = flagged.some((f) => f.status === "removed");
  const changedCount = flagged.filter((f) => f.status === "changed").length;

  if (hasRemoved || changedCount >= 2) return "HIGH";
  if (changedCount === 1) return "MEDIUM";
  return "LOW";
}

function applySemverWeighting(
  level: RiskLevel,
  flagged: FlaggedEntry[],
  fromVersion: string,
  toVersion: string,
): RiskLevel {
  if (!isMajorBump(fromVersion, toVersion)) return level;
  if (flagged.some((f) => f.status === "removed" || f.changeKind === "param_removed")) {
    return "HIGH";
  }
  if (level === "LOW" && flagged.length > 0) return "MEDIUM";
  return level;
}

export function isMajorBump(fromVersion: string, toVersion: string): boolean {
  const fromMajor = Number.parseInt(fromVersion.split(".")[0] ?? "0", 10);
  const toMajor = Number.parseInt(toVersion.split(".")[0] ?? "0", 10);
  return Number.isFinite(fromMajor) && Number.isFinite(toMajor) && toMajor > fromMajor;
}

function inferChangeKind(entry: ApiDiffEntry): ChangeKind {
  if (entry.status === "removed") return "removed";
  if (entry.deprecated && entry.oldSignature === entry.newSignature) return "deprecated";
  return "signature_changed";
}

function summarizeChange(entry: ApiDiffEntry, kind: ChangeKind): string {
  switch (kind) {
    case "removed":
      return "export removed";
    case "deprecated":
      return "marked @deprecated";
    case "param_removed":
      return "signature changed: parameter(s) removed";
    case "param_added":
      return "signature changed: parameters added";
    case "return_changed":
      return "return type changed";
    case "type_changed":
      return "type definition changed";
    case "signature_changed":
    default:
      if (entry.deprecated) return "signature changed and marked @deprecated";
      return "signature changed";
  }
}
