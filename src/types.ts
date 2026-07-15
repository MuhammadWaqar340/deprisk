export type ApiDiffStatus = "removed" | "changed" | "added" | "unchanged";

export interface ApiDiffEntry {
  name: string;
  status: ApiDiffStatus;
  oldSignature?: string;
  newSignature?: string;
  deprecated?: boolean;
}

export interface UsageLocation {
  filePath: string;
  line: number;
}

export type UsageMap = Record<string, UsageLocation[]>;

export type RiskLevel = "HIGH" | "MEDIUM" | "LOW";

export interface FlaggedEntry {
  name: string;
  status: "removed" | "changed";
  oldSignature?: string;
  newSignature?: string;
  deprecated?: boolean;
  usages: UsageLocation[];
  /** Human-readable summary of what changed */
  summary: string;
}

export interface RiskReport {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  level: RiskLevel;
  flagged: FlaggedEntry[];
  unusedChangeCount: number;
  /** True when the package is not directly imported in the project */
  notImported?: boolean;
}

export interface TypedPackagePaths {
  kind: "typed";
  oldRoot: string;
  newRoot: string;
  oldTypesEntry: string;
  newTypesEntry: string;
}

export interface UntypedPackageResult {
  kind: "untyped";
  packageName: string;
  message: string;
}

export type FetchResult = TypedPackagePaths | UntypedPackageResult;
