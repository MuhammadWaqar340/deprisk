import type { RiskReport } from "./types.js";

export { fetchPackageVersions, toDefinitelyTypedName, resolveTypesEntry } from "./fetcher.js";
export { diffApiSurfaces, extractApiSurface, classifyChangeKind } from "./apiDiff.js";
export { scanPackageUsage, discoverWorkspaceRoots } from "./usageScanner.js";
export { scoreRisk, isMajorBump } from "./riskScorer.js";
export {
  detectVersionBumps,
  diffNpmLockfiles,
  resolveFromTo,
  resolveLockedVersion,
  readNpmLockVersions,
} from "./versionDetect.js";
export { loadIgnoreSet, filterIgnoredNames } from "./ignore.js";
export {
  formatMarkdownReport,
  formatHtmlReport,
  formatScanSummary,
  formatScanMarkdown,
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
export type { FailOn } from "./exitCode.js";
export type { RiskReport };
