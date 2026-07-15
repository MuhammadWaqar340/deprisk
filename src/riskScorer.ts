import type {
  ApiDiffEntry,
  ChangeKind,
  FlaggedEntry,
  RiskLevel,
  RiskReport,
  TypesSource,
  UsageMap,
} from "./types.js";

export interface ScoreRiskInput {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  diff: ApiDiffEntry[];
  usage: UsageMap;
  typesSource?: { old: TypesSource; new: TypesSource };
  /** When true, a major-version bump with any removal escalates toward HIGH */
  semverWeighting?: boolean;
}

/**
 * Cross-reference API diff entries with local usages to produce a risk report.
 *
 * HIGH   — any flagged entry is removed, OR 2+ flagged entries are changed
 * MEDIUM — exactly 1 flagged entry with status changed
 * LOW    — no flagged entries (or package not imported)
 *
 * With semverWeighting: major bump + any removed used export stays HIGH;
 * major bump + a single param_added-only change stays MEDIUM (not escalated).
 */
export function scoreRisk(input: ScoreRiskInput): RiskReport {
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

  let level = computeLevel(flagged);

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

function computeLevel(flagged: FlaggedEntry[]): RiskLevel {
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
