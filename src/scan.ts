import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fetchPackageVersions } from "./fetcher.js";
import { diffApiSurfaces } from "./apiDiff.js";
import { scanPackageUsage, discoverWorkspaceRoots } from "./usageScanner.js";
import { scoreRisk } from "./riskScorer.js";
import { diffNpmLockfiles, readNpmLockVersions } from "./versionDetect.js";
import { loadIgnoreSet, filterIgnoredNames } from "./ignore.js";
import { resolveLatestVersion } from "./latest.js";
import type { RiskLevel, RiskReport, VersionBump } from "./types.js";

export interface ScanOptions {
  path: string;
  /** PR bump mode */
  baseLock?: string;
  baseRef?: string;
  headLock?: string;
  /** Latest audit mode */
  latest?: boolean;
  /** Include every top-level lockfile package (latest mode) */
  all?: boolean;
  includeDev?: boolean;
  followReexports?: boolean;
  workspaces?: boolean;
  semverWeight?: boolean;
  concurrency?: number;
  resolveLatest?: (packageName: string) => Promise<string>;
  onBump?: (bump: VersionBump, index: number, total: number) => void;
}

export interface UpToDateEntry {
  packageName: string;
  version: string;
}

export interface ScanResult {
  mode: "bumps" | "latest";
  bumps: VersionBump[];
  reports: RiskReport[];
  upToDate: UpToDateEntry[];
  errors: { packageName: string; message: string }[];
  worstLevel: RiskLevel;
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
  },
): Promise<RiskReport> {
  const fetched = await fetchPackageVersions(packageName, fromVersion, toVersion);
  if (fetched.kind === "untyped") {
    throw new Error(fetched.message);
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

  let diff = diffApiSurfaces(fetched.oldTypesEntry, fetched.newTypesEntry);
  diff = filterIgnoredNames(diff, ignore);

  return scoreRisk({
    packageName,
    fromVersion,
    toVersion,
    diff,
    usage,
    typesSource: fetched.typesSource,
    semverWeighting: opts.semverWeight,
  });
}

/**
 * Resolve version bumps from --base-lock or --base-ref against the project lockfile.
 */
export function resolveScanBumps(options: {
  path: string;
  baseLock?: string;
  baseRef?: string;
  headLock?: string;
  includeDev?: boolean;
}): VersionBump[] {
  const projectDir = path.resolve(options.path);
  const headPath = options.headLock
    ? path.resolve(options.headLock)
    : path.join(projectDir, "package-lock.json");

  if (!fs.existsSync(headPath)) {
    throw new Error(
      `Head lockfile not found: ${headPath}. DepRisk scan requires package-lock.json.`,
    );
  }

  let baseJson: string;
  if (options.baseLock) {
    const basePath = path.resolve(options.baseLock);
    if (!fs.existsSync(basePath)) {
      throw new Error(`Base lockfile not found: ${basePath}`);
    }
    baseJson = fs.readFileSync(basePath, "utf8");
  } else if (options.baseRef) {
    baseJson = readLockfileFromGitRef(projectDir, options.baseRef, "package-lock.json");
  } else {
    throw new Error(
      "Pass --base-lock <file>, --base-ref <git-ref>, or --latest.",
    );
  }

  const headJson = fs.readFileSync(headPath, "utf8");
  let bumps = diffNpmLockfiles(baseJson, headJson);

  if (options.includeDev === false) {
    bumps = filterProdDepsOnly(projectDir, bumps);
  }

  bumps.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return bumps;
}

/**
 * Build locked→latest bumps for audit mode.
 * Returns candidates; caller separates up-to-date after resolving latest.
 */
export function listLockedPackagesForLatestAudit(
  projectDir: string,
  options: { all?: boolean; includeDev?: boolean } = {},
): { packageName: string; lockedVersion: string }[] {
  const abs = path.resolve(projectDir);
  const lockPath = path.join(abs, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    throw new Error(
      `package-lock.json not found in ${abs}. --latest currently requires an npm lockfile.`,
    );
  }

  const locked = readNpmLockVersions(fs.readFileSync(lockPath, "utf8"));
  let names: string[];

  if (options.all) {
    names = [...locked.keys()];
  } else {
    names = readDirectDependencyNames(abs, options.includeDev !== false);
  }

  const result: { packageName: string; lockedVersion: string }[] = [];
  for (const name of names.sort()) {
    const version = locked.get(name);
    if (!version) continue;
    result.push({ packageName: name, lockedVersion: version });
  }
  return result;
}

function readDirectDependencyNames(projectDir: string, includeDev: boolean): string[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
  ) as {
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
      `Could not read ${lockfileName} from git ref "${ref}". `
        + `Fetch the ref first (e.g. git fetch origin main).`,
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
  });

  return analyzeBumps(bumps, options, "bumps");
}

async function runLatestAudit(options: ScanOptions): Promise<ScanResult> {
  const lockedList = listLockedPackagesForLatestAudit(options.path, {
    all: options.all,
    includeDev: options.includeDev,
  });

  const resolveLatest = options.resolveLatest ?? resolveLatestVersion;
  const bumps: VersionBump[] = [];
  const upToDate: UpToDateEntry[] = [];
  const errors: ScanResult["errors"] = [];

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
  };
}

async function analyzeBumps(
  bumps: VersionBump[],
  options: ScanOptions,
  mode: "bumps" | "latest",
): Promise<ScanResult> {
  const reports: RiskReport[] = [];
  const errors: ScanResult["errors"] = [];
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
          },
        );
        reports.push(report);
      } catch (err) {
        errors.push({
          packageName: bump.packageName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, bumps.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);

  reports.sort((a, b) => a.packageName.localeCompare(b.packageName));
  errors.sort((a, b) => a.packageName.localeCompare(b.packageName));

  return {
    mode,
    bumps,
    reports,
    upToDate: [],
    errors,
    worstLevel: worstLevel(reports),
  };
}

export function worstLevel(reports: RiskReport[]): RiskLevel {
  if (reports.some((r) => r.level === "HIGH")) return "HIGH";
  if (reports.some((r) => r.level === "MEDIUM")) return "MEDIUM";
  return "LOW";
}
