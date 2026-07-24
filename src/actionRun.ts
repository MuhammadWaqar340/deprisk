import fs from "node:fs";
import path from "node:path";
import { analyzePackage, worstLevel } from "./scan.js";
import { diffLockfileVersions } from "./versionDetect.js";
import { formatMarkdownReport } from "./reportFormat.js";
import { computeExitCode, normalizeFailOn } from "./exitCode.js";
import { isUntypedPackageError } from "./analysisErrors.js";
import type { RiskReport, VersionBump } from "./types.js";

export interface ActionRunResult {
  reports: RiskReport[];
  skipped: { packageName: string; message: string }[];
  errors: { packageName: string; message: string }[];
  exitCode: number;
}

/**
 * Core GitHub Action logic — shared exit-code rules with the CLI via computeExitCode.
 */
export async function runAction(options: {
  projectPath: string;
  failOnRaw: string;
  packageFilter?: string;
  from?: string;
  to?: string;
  baseLock?: string;
  headLock?: string;
  /** Injectable analyze for tests */
  analyze?: typeof analyzePackage;
}): Promise<ActionRunResult> {
  const failOn = normalizeFailOn(options.failOnRaw || "high") ?? "high";
  const analyze = options.analyze ?? analyzePackage;
  const bumps: VersionBump[] = [];

  if (options.packageFilter && options.from && options.to) {
    bumps.push({
      packageName: options.packageFilter,
      fromVersion: options.from,
      toVersion: options.to,
    });
  } else if (
    options.baseLock
    && options.headLock
    && fs.existsSync(options.baseLock)
    && fs.existsSync(options.headLock)
  ) {
    const baseName = path.basename(options.baseLock);
    const headName = path.basename(options.headLock);
    const kind =
      baseName === "pnpm-lock.yaml" || headName === "pnpm-lock.yaml"
        ? "pnpm" as const
        : baseName === "yarn.lock" || headName === "yarn.lock"
          ? "yarn" as const
          : "npm" as const;
    bumps.push(
      ...diffLockfileVersions(
        kind,
        fs.readFileSync(options.baseLock, "utf8"),
        fs.readFileSync(options.headLock, "utf8"),
        options.packageFilter || undefined,
      ),
    );
  }

  if (bumps.length === 0) {
    return { reports: [], skipped: [], errors: [], exitCode: 0 };
  }

  const reports: RiskReport[] = [];
  const skipped: ActionRunResult["skipped"] = [];
  const errors: ActionRunResult["errors"] = [];

  for (const bump of bumps) {
    try {
      const report = await analyze(
        bump.packageName,
        bump.fromVersion,
        bump.toVersion,
        {
          path: options.projectPath,
          followReexports: true,
          semverWeight: true,
        },
      );
      reports.push(report);
    } catch (err) {
      if (isUntypedPackageError(err)) {
        skipped.push({ packageName: bump.packageName, message: err.message });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ packageName: bump.packageName, message });
      }
    }
  }

  const exitCode = computeExitCode(
    worstLevel(reports),
    failOn,
    errors.length > 0,
  );

  return { reports, skipped, errors, exitCode };
}

export function formatActionReports(reports: RiskReport[]): string {
  return reports.map(formatMarkdownReport).join("\n\n---\n\n");
}
