import type { RiskReport } from "./types.js";

export { fetchPackageVersions, toDefinitelyTypedName, resolveTypesEntry } from "./fetcher.js";
export { diffApiSurfaces, extractApiSurface, classifyChangeKind } from "./apiDiff.js";
export { scanPackageUsage, discoverWorkspaceRoots } from "./usageScanner.js";
export { scoreRisk, isMajorBump } from "./riskScorer.js";
export { detectVersionBumps, diffNpmLockfiles, resolveFromTo } from "./versionDetect.js";
export { loadIgnoreSet, filterIgnoredNames } from "./ignore.js";
export { formatMarkdownReport, formatHtmlReport } from "./reportFormat.js";
export type { RiskReport };
