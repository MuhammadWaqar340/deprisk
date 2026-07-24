export type ApiDiffStatus = "removed" | "changed" | "added" | "unchanged";

export type ChangeKind =
  | "removed"
  | "deprecated"
  | "param_removed"
  | "param_added"
  | "return_changed"
  | "type_changed"
  | "signature_changed";

export interface ApiDiffEntry {
  name: string;
  status: ApiDiffStatus;
  oldSignature?: string;
  newSignature?: string;
  deprecated?: boolean;
  changeKind?: ChangeKind;
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
  changeKind?: ChangeKind;
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
  /** Where .d.ts came from for each side */
  typesSource?: {
    old: TypesSource;
    new: TypesSource;
  };
}

export type TypesSource = "bundled" | "definitelyTyped";

export interface TypedPackagePaths {
  kind: "typed";
  oldRoot: string;
  newRoot: string;
  oldTypesEntry: string;
  newTypesEntry: string;
  typesSource: {
    old: TypesSource;
    new: TypesSource;
  };
}

export interface UntypedPackageResult {
  kind: "untyped";
  packageName: string;
  message: string;
  /** Stable reason code for SKIPPED classification */
  reason?: "no-types";
}

export type FetchResult = TypedPackagePaths | UntypedPackageResult;

export interface VersionBump {
  packageName: string;
  fromVersion: string;
  toVersion: string;
}
