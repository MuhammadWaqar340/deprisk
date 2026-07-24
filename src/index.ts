import type { RiskReport } from "./types.js";

export { fetchPackageVersions, toDefinitelyTypedName, resolveTypesEntry } from "./fetcher.js";
export { analyzeCompatibility, worstCompatibility } from "./compatibility.js";
export { diffApiSurfaces, diffExtractedSurfaces, extractApiSurface, classifyChangeKind } from "./apiDiff.js";
export { scanPackageUsage, discoverWorkspaceRoots } from "./usageScanner.js";
export { scoreRisk, isMajorBump } from "./riskScorer.js";
export {
  detectVersionBumps,
  diffNpmLockfiles,
  diffLockfileVersions,
  resolveFromTo,
  resolveLockedVersion,
  readNpmLockVersions,
  readPnpmLockVersions,
  parseNpmLockVersionsOrThrow,
  parsePnpmLockVersionsOrThrow,
} from "./versionDetect.js";
export { loadIgnoreSet, filterIgnoredNames } from "./ignore.js";
export {
  formatMarkdownReport,
  formatHtmlReport,
  formatScanSummary,
  formatScanMarkdown,
  countScanStatuses,
} from "./reportFormat.js";
export { initGitHubWorkflow, generateWorkflowYaml } from "./init.js";
export {
  runScan,
  analyzePackage,
  resolveScanBumps,
  listLockedPackagesForLatestAudit,
  worstLevel,
} from "./scan.js";
export { resolveLatestVersion, isStableVersion, compareSemverDesc } from "./latest.js";
export { resolveCheckVersions } from "./checkResolve.js";
export { computeExitCode, normalizeFailOn, FAIL_ON_VALUES } from "./exitCode.js";
export { detectLockfiles, requireLockfileForLatest, requireLockfileForPrMode } from "./lockfileDetect.js";
export { loadDepRiskConfig, validateDepRiskConfig, mergeConfig } from "./config.js";
export { formatScanSarif, writeSarifFile, validateSarifLog } from "./sarifFormat.js";
export { runAction } from "./actionRun.js";
export { UntypedPackageError, isUntypedPackageError } from "./analysisErrors.js";
export type { FailOn } from "./exitCode.js";
export type { DepRiskConfig } from "./config.js";
export type { RiskReport };
export type {
  Compatibility,
  Confidence,
  CompatFinding,
  CompatFindingKind,
  UsageLocation,
  UsageKind,
} from "./types.js";
