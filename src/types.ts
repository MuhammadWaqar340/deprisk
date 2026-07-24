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

export type UsageKind = "call" | "property" | "destructure" | "reference";

export interface UsageLocation {
  filePath: string;
  line: number;
  /** How the export is used at this site (Phase 2) */
  kind?: UsageKind;
  /** Argument count when kind is "call" */
  argCount?: number;
  /** Coarse argument type hints from literals: string|number|boolean|object|unknown */
  argTypeHints?: string[];
  /** Top-level object-literal keys from call arguments */
  argKeys?: string[];
  /** Property name when kind is "property" or destructured key */
  propertyName?: string;
  /** Keys when kind is "destructure" */
  destructuredKeys?: string[];
  /**
   * When a call result is assigned and then property-accessed:
   * true if all accesses are null-checked / optional-chained.
   */
  returnAccessSafe?: boolean;
}

export type UsageMap = Record<string, UsageLocation[]>;

export type RiskLevel = "HIGH" | "MEDIUM" | "LOW";

/** Phase 2: usage compatibility vs the new API */
export type Compatibility =
  | "COMPATIBLE"
  | "INCOMPATIBLE"
  | "POTENTIALLY_INCOMPATIBLE"
  | "UNKNOWN"
  | "NOT_USED";

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export type CompatFindingKind =
  | "REMOVED"
  | "PARAM_REMOVED"
  | "PARAM_ADDED_REQUIRED"
  | "PARAM_ADDED_OPTIONAL"
  | "OPTIONS_PROP_REMOVED"
  | "OPTIONS_PROP_REQUIRED"
  | "PROPERTY_REMOVED"
  | "METHOD_REMOVED"
  | "RETURN_NULLABLE"
  | "OVERLOAD_REMOVED"
  | "GENERIC_CONSTRAINT"
  | "TYPE_CHANGED"
  | "SIGNATURE_CHANGED"
  | "UNKNOWN";

export interface CompatFinding {
  symbol: string;
  kind: CompatFindingKind;
  compatibility: Compatibility;
  confidence: Confidence;
  file?: string;
  line?: number;
  reason: string;
  recommendation?: string;
  oldSignature?: string;
  newSignature?: string;
  usageSummary?: string;
}

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
  compatibility?: Compatibility;
  confidence?: Confidence;
  findings?: CompatFinding[];
}

export interface RiskReport {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  level: RiskLevel;
  flagged: FlaggedEntry[];
  unusedChangeCount: number;
  /** Used API changes that remain compatible with current call sites */
  compatibleChangeCount?: number;
  /** Aggregate compatibility across findings */
  compatibility?: Compatibility;
  /** Aggregate confidence */
  confidence?: Confidence;
  /** Flat list of deep compatibility findings */
  findings?: CompatFinding[];
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
