import type { ApiDiffEntry, FlaggedEntry, RiskLevel, RiskReport, UsageMap } from "./types.js";

export interface ScoreRiskInput {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  diff: ApiDiffEntry[];
  usage: UsageMap;
}

/**
 * Cross-reference API diff entries with local usages to produce a risk report.
 *
 * HIGH   — any flagged entry is removed, OR 2+ flagged entries are changed
 * MEDIUM — exactly 1 flagged entry with status changed
 * LOW    — no flagged entries (or package not imported)
 */
export function scoreRisk(input: ScoreRiskInput): RiskReport {
  const { packageName, fromVersion, toVersion, diff, usage } = input;
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

    flagged.push({
      name: entry.name,
      status: entry.status,
      oldSignature: entry.oldSignature,
      newSignature: entry.newSignature,
      deprecated: entry.deprecated,
      usages,
      summary: summarizeChange(entry),
    });
  }

  // Sort flagged by severity (removed first), then name
  flagged.sort((a, b) => {
    if (a.status !== b.status) return a.status === "removed" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const level = computeLevel(flagged);

  return {
    packageName,
    fromVersion,
    toVersion,
    level,
    flagged,
    unusedChangeCount,
    ...(notImported ? { notImported: true } : {}),
  };
}

function computeLevel(flagged: FlaggedEntry[]): RiskLevel {
  if (flagged.length === 0) return "LOW";

  const hasRemoved = flagged.some((f) => f.status === "removed");
  const changedCount = flagged.filter((f) => f.status === "changed").length;

  if (hasRemoved || changedCount >= 2) return "HIGH";
  if (changedCount === 1) return "MEDIUM";
  return "LOW";
}

function summarizeChange(entry: ApiDiffEntry): string {
  if (entry.status === "removed") {
    return "export removed";
  }

  if (entry.deprecated && entry.oldSignature === entry.newSignature) {
    return "marked @deprecated";
  }

  if (entry.deprecated) {
    return "signature changed and marked @deprecated";
  }

  // Heuristic short summaries from signature diffs
  const oldSig = entry.oldSignature ?? "";
  const newSig = entry.newSignature ?? "";

  if (oldSig.includes("defaultValue") && !newSig.includes("defaultValue")) {
    return "parameter removed from signature";
  }

  if (countParams(newSig) > countParams(oldSig)) {
    return "signature changed: parameters added";
  }

  if (countParams(newSig) < countParams(oldSig)) {
    return "signature changed: parameter(s) removed";
  }

  if (oldSig.startsWith("type ") || oldSig.startsWith("interface ")) {
    return "type definition changed";
  }

  return "signature changed";
}

function countParams(sig: string): number {
  const match = /\((.*)\)/.exec(sig);
  if (!match || !match[1].trim()) return 0;
  // Rough count — good enough for summary text
  return match[1].split(",").length;
}
