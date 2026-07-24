import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fetchPackageVersions } from "./fetcher.js";
import { diffExtractedSurfaces, extractApiSurface } from "./apiDiff.js";
import { analyzeCompatibility } from "./compatibility.js";
import { scanPackageUsage, discoverWorkspaceRoots } from "./usageScanner.js";
import { scoreRisk } from "./riskScorer.js";
import {
  diffLockfileVersions,
  parseNpmLockVersionsOrThrow,
  parsePnpmLockVersionsOrThrow,
} from "./versionDetect.js";
import { loadIgnoreSet, filterIgnoredNames } from "./ignore.js";
import { resolveLatestVersion } from "./latest.js";
import { UntypedPackageError, isUntypedPackageError } from "./analysisErrors.js";
import {
  detectLockfiles,
  requireLockfileForLatest,
  requireLockfileForPrMode,
  type LockfileKind,
} from "./lockfileDetect.js";
import type { FetchResult, RiskLevel, RiskReport, VersionBump } from "./types.js";

export type FetchVersionsFn = (
  packageName: string,
  fromVersion: string,
  toVersion: string,
) => Promise<FetchResult>;

export interface ScanOptions {
  path: string;
  baseLock?: string;
  baseRef?: string;
  headLock?: string;
  latest?: boolean;
  all?: boolean;
  includeDev?: boolean;
  followReexports?: boolean;
  workspaces?: boolean;
  semverWeight?: boolean;
  concurrency?: number;
  resolveLatest?: (packageName: string) => Promise<string>;
  /** Injectable for tests — defaults to fetchPackageVersions */
  fetchVersions?: FetchVersionsFn;
  onBump?: (bump: VersionBump, index: number, total: number) => void;
  onLockfileWarning?: (warning: string) => void;
}

export interface UpToDateEntry {
  packageName: string;
  version: string;
}

export interface SkippedEntry {
  packageName: string;
  fromVersion?: string;
  toVersion?: string;
  reason: "no-types";
  message: string;
}

export interface ScanResult {
  mode: "bumps" | "latest";
  bumps: VersionBump[];
  reports: RiskReport[];
  upToDate: UpToDateEntry[];
  skipped: SkippedEntry[];
  errors: { packageName: string; message: string }[];
  worstLevel: RiskLevel;
  lockfileKind?: LockfileKind;
}

/**
 * Analyze a single package bump without printing.
 */
export async function analyzePackage(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  opts: {
    path: string;
    followReexports?: boolean;
    workspaces?: boolean;
    semverWeight?: boolean;
    fetchVersions?: FetchVersionsFn;
  },
): Promise<RiskReport> {
  const fetchFn = opts.fetchVersions ?? fetchPackageVersions;
  const fetched = await fetchFn(packageName, fromVersion, toVersion);
  if (fetched.kind === "untyped") {
    throw new UntypedPackageError(packageName, fetched.message);
  }

  const extraRoots = opts.workspaces ? discoverWorkspaceRoots(opts.path) : [];
  const usage = scanPackageUsage(opts.path, packageName, {
    followReexports: opts.followReexports,
    extraRoots,
  });

  const ignore = loadIgnoreSet(opts.path, packageName);
  for (const name of ignore) {
    delete usage[name];
  }

  const oldSymbols = extractApiSurface(fetched.oldTypesEntry);
  const newSymbols = extractApiSurface(fetched.newTypesEntry);
  let diff = diffExtractedSurfaces(oldSymbols, newSymbols);
  diff = filterIgnoredNames(diff, ignore);

  const compat = analyzeCompatibility({
    diff,
    usage,
    oldSymbols,
    newSymbols,
  });

  return scoreRisk({
    packageName,
    fromVersion,
    toVersion,
    diff,
    usage,
    typesSource: fetched.typesSource,
    semverWeighting: opts.semverWeight,
    compat,
  });
}

/**
 * Resolve version bumps from --base-lock or --base-ref against the project lockfile.
 * Uses centralized lockfile detection (npm or pnpm). Yarn PR mode is unsupported.
 */
export function resolveScanBumps(options: {
  path: string;
  baseLock?: string;
  baseRef?: string;
  headLock?: string;
  includeDev?: boolean;
  onLockfileWarning?: (warning: string) => void;
}): VersionBump[] {
  const projectDir = path.resolve(options.path);

  let kind: LockfileKind;
  let headPath: string;
  let lockfileName: string;

  if (options.headLock) {
    headPath = path.resolve(options.headLock);
    if (!fs.existsSync(headPath)) {
      throw new Error(
        `Head lockfile not found: ${headPath}.\n`
          + `Pass a valid --head-lock path, or omit it to auto-detect in the project.`,
      );
    }
    kind = inferKindFromPath(headPath);
    lockfileName = path.basename(headPath);
    if (kind === "yarn") {
      throw yarnPrUnsupportedError(headPath);
    }
  } else {
    const detected = requireLockfileForPrMode(projectDir);
    if (detected.warning) options.onLockfileWarning?.(detected.warning);
    kind = detected.primary!.kind;
    headPath = detected.primary!.absolutePath;
    lockfileName = detected.primary!.fileName;
  }

  let baseText: string;
  if (options.baseLock) {
    const basePath = path.resolve(options.baseLock);
    if (!fs.existsSync(basePath)) {
      throw new Error(
        `Base lockfile not found: ${basePath}\n`
          + `Check the path or pass --base-ref origin/main instead.`,
      );
    }
    // CI often checks out the base lock as a temp name (e.g. base.json).
    // When the basename is not a known lockfile, inherit the head lockfile kind.
    const baseKind = tryInferKindFromPath(basePath);
    if (baseKind != null && baseKind !== kind) {
      throw new Error(
        `Base lockfile type (${baseKind}) does not match head (${kind}).\n`
          + `Use matching lockfile formats for PR bump comparison.`,
      );
    }
    baseText = fs.readFileSync(basePath, "utf8");
  } else if (options.baseRef) {
    baseText = readLockfileFromGitRef(projectDir, options.baseRef, lockfileName);
  } else {
    throw new Error(
      "Pass --base-lock <file>, --base-ref <git-ref>, or --latest.",
    );
  }

  const headText = fs.readFileSync(headPath, "utf8");
  let bumps: VersionBump[];
  try {
    bumps = diffLockfileVersions(kind, baseText, headText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to compare ${lockfileName} for PR bumps.\n${msg}`,
    );
  }

  if (options.includeDev === false) {
    bumps = filterProdDepsOnly(projectDir, bumps);
  }

  bumps.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return bumps;
}

function tryInferKindFromPath(filePath: string): LockfileKind | null {
  const base = path.basename(filePath);
  if (base === "pnpm-lock.yaml" || base.endsWith("pnpm-lock.yaml")) return "pnpm";
  if (base === "yarn.lock" || base.endsWith("yarn.lock")) return "yarn";
  if (base === "package-lock.json" || base.endsWith("package-lock.json")) return "npm";
  return null;
}

function inferKindFromPath(filePath: string): LockfileKind {
  const kind = tryInferKindFromPath(filePath);
  if (kind) return kind;
  throw new Error(
    `Unrecognized lockfile name "${path.basename(filePath)}".\n`
      + `Expected package-lock.json, pnpm-lock.yaml, or yarn.lock.`,
  );
}

function yarnPrUnsupportedError(filePath: string): Error {
  return new Error(
    `Found ${path.basename(filePath)} but DepRisk PR bump mode does not support Yarn yet.\n`
      + `Use package-lock.json or pnpm-lock.yaml for --base-lock/--base-ref scans,\n`
      + `or analyze a single package with: deprisk check <pkg> --from <A> --to <B>.`,
  );
}

/**
 * Build locked→latest package list for audit mode (npm or pnpm lockfile).
 */
export function listLockedPackagesForLatestAudit(
  projectDir: string,
  options: {
    all?: boolean;
    includeDev?: boolean;
    onLockfileWarning?: (warning: string) => void;
  } = {},
): { packageName: string; lockedVersion: string; lockfileKind: LockfileKind }[] {
  const abs = path.resolve(projectDir);
  const detected = requireLockfileForLatest(abs);
  if (detected.warning) options.onLockfileWarning?.(detected.warning);

  const primary = detected.primary!;
  const lockText = fs.readFileSync(primary.absolutePath, "utf8");
  let locked: Map<string, string>;
  try {
    locked =
      primary.kind === "pnpm"
        ? parsePnpmLockVersionsOrThrow(lockText, primary.fileName)
        : parseNpmLockVersionsOrThrow(lockText, primary.fileName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }

  let names: string[];
  if (options.all) {
    names = [...locked.keys()];
  } else {
    names = readDirectDependencyNames(abs, options.includeDev !== false);
  }

  const result: {
    packageName: string;
    lockedVersion: string;
    lockfileKind: LockfileKind;
  }[] = [];
  for (const name of names.sort()) {
    const version = locked.get(name);
    if (!version) continue;
    result.push({
      packageName: name,
      lockedVersion: version,
      lockfileKind: primary.kind,
    });
  }
  return result;
}

function readDirectDependencyNames(projectDir: string, includeDev: boolean): string[] {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `package.json not found in ${projectDir}.\n`
        + `Pass --path <projectDir> pointing at your app root.`,
    );
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = new Set<string>(Object.keys(pkg.dependencies ?? {}));
  if (includeDev) {
    for (const n of Object.keys(pkg.devDependencies ?? {})) names.add(n);
  }
  return [...names];
}

function readLockfileFromGitRef(
  projectDir: string,
  ref: string,
  lockfileName: string,
): string {
  try {
    return execFileSync("git", ["show", `${ref}:${lockfileName}`], {
      cwd: projectDir,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      `Could not read ${lockfileName} from git ref "${ref}".\n`
        + `Fetch the ref first (e.g. git fetch origin ${ref.replace(/^origin\//, "")}), `
        + `or pass --base-lock <file> with a local copy.`,
    );
  }
}

function filterProdDepsOnly(projectDir: string, bumps: VersionBump[]): VersionBump[] {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const prod = new Set(Object.keys(pkg.dependencies ?? {}));
    return bumps.filter((b) => prod.has(b.packageName));
  } catch {
    return bumps;
  }
}

/**
 * Run DepRisk across detected bumps (PR mode) or lockfile→latest (audit mode).
 */
export async function runScan(options: ScanOptions): Promise<ScanResult> {
  if (options.latest && (options.baseLock || options.baseRef)) {
    throw new Error(
      "Use either --latest (audit) or --base-lock/--base-ref (PR bumps), not both.",
    );
  }

  if (options.latest) {
    return runLatestAudit(options);
  }

  const bumps = resolveScanBumps({
    path: options.path,
    baseLock: options.baseLock,
    baseRef: options.baseRef,
    headLock: options.headLock,
    includeDev: options.includeDev,
    onLockfileWarning: options.onLockfileWarning,
  });

  const analyzed = await analyzeBumps(bumps, options, "bumps");
  const detected = detectLockfiles(options.path);
  return {
    ...analyzed,
    lockfileKind: detected.primary?.kind,
  };
}

async function runLatestAudit(options: ScanOptions): Promise<ScanResult> {
  const lockedList = listLockedPackagesForLatestAudit(options.path, {
    all: options.all,
    includeDev: options.includeDev,
    onLockfileWarning: options.onLockfileWarning,
  });

  const resolveLatest = options.resolveLatest ?? resolveLatestVersion;
  const bumps: VersionBump[] = [];
  const upToDate: UpToDateEntry[] = [];
  const errors: ScanResult["errors"] = [];
  const lockfileKind = lockedList[0]?.lockfileKind;

  for (const item of lockedList) {
    try {
      const latest = await resolveLatest(item.packageName);
      if (latest === item.lockedVersion) {
        upToDate.push({ packageName: item.packageName, version: item.lockedVersion });
      } else {
        bumps.push({
          packageName: item.packageName,
          fromVersion: item.lockedVersion,
          toVersion: latest,
        });
      }
    } catch (err) {
      errors.push({
        packageName: item.packageName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const analyzed = await analyzeBumps(bumps, options, "latest");
  return {
    ...analyzed,
    upToDate,
    errors: [...errors, ...analyzed.errors],
    lockfileKind,
  };
}

async function analyzeBumps(
  bumps: VersionBump[],
  options: ScanOptions,
  mode: "bumps" | "latest",
): Promise<ScanResult> {
  const reports: RiskReport[] = [];
  const errors: ScanResult["errors"] = [];
  const skipped: SkippedEntry[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 4);

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < bumps.length) {
      const i = nextIndex++;
      const bump = bumps[i];
      options.onBump?.(bump, i, bumps.length);
      try {
        const report = await analyzePackage(
          bump.packageName,
          bump.fromVersion,
          bump.toVersion,
          {
            path: options.path,
            followReexports: options.followReexports,
            workspaces: options.workspaces,
            semverWeight: options.semverWeight,
            fetchVersions: options.fetchVersions,
          },
        );
        reports.push(report);
      } catch (err) {
        if (isUntypedPackageError(err)) {
          skipped.push({
            packageName: bump.packageName,
            fromVersion: bump.fromVersion,
            toVersion: bump.toVersion,
            reason: "no-types",
            message: err.message,
          });
        } else {
          errors.push({
            packageName: bump.packageName,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, bumps.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);

  reports.sort((a, b) => a.packageName.localeCompare(b.packageName));
  errors.sort((a, b) => a.packageName.localeCompare(b.packageName));
  skipped.sort((a, b) => a.packageName.localeCompare(b.packageName));

  return {
    mode,
    bumps,
    reports,
    upToDate: [],
    skipped,
    errors,
    worstLevel: worstLevel(reports),
  };
}

export function worstLevel(reports: RiskReport[]): RiskLevel {
  if (reports.some((r) => r.level === "HIGH")) return "HIGH";
  if (reports.some((r) => r.level === "MEDIUM")) return "MEDIUM";
  return "LOW";
}
