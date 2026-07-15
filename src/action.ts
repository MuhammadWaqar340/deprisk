/**
 * GitHub Action entry — runs DepRisk and optionally comments on the PR.
 * Designed to be invoked via action.yml (node20).
 */
import fs from "node:fs";
import path from "node:path";
import { fetchPackageVersions } from "./fetcher.js";
import { diffApiSurfaces } from "./apiDiff.js";
import { scanPackageUsage } from "./usageScanner.js";
import { scoreRisk } from "./riskScorer.js";
import { diffNpmLockfiles } from "./versionDetect.js";
import { formatMarkdownReport } from "./reportFormat.js";
import type { RiskReport, VersionBump } from "./types.js";

function getInput(name: string, fallback = ""): string {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return (process.env[key] ?? fallback).trim();
}

async function main(): Promise<void> {
  const projectPath = path.resolve(getInput("path", "."));
  const failOn = getInput("fail-on", "high").toLowerCase();
  const packageFilter = getInput("package");
  const from = getInput("from");
  const to = getInput("to");
  const baseLock = getInput("base-lockfile");
  const headLock = getInput("head-lockfile");
  const token = getInput("github-token", process.env.GITHUB_TOKEN ?? "");

  const bumps: VersionBump[] = [];

  if (packageFilter && from && to) {
    bumps.push({ packageName: packageFilter, fromVersion: from, toVersion: to });
  } else if (baseLock && headLock && fs.existsSync(baseLock) && fs.existsSync(headLock)) {
    bumps.push(
      ...diffNpmLockfiles(
        fs.readFileSync(baseLock, "utf8"),
        fs.readFileSync(headLock, "utf8"),
        packageFilter || undefined,
      ),
    );
  } else if (packageFilter && from && to) {
    bumps.push({ packageName: packageFilter, fromVersion: from, toVersion: to });
  }

  if (bumps.length === 0) {
    console.log("No dependency version bumps detected — nothing to check.");
    return;
  }

  const reports: RiskReport[] = [];

  for (const bump of bumps) {
    console.log(`Checking ${bump.packageName} ${bump.fromVersion} → ${bump.toVersion}`);
    const fetched = await fetchPackageVersions(
      bump.packageName,
      bump.fromVersion,
      bump.toVersion,
    );
    if (fetched.kind === "untyped") {
      console.warn(fetched.message);
      continue;
    }
    const diff = diffApiSurfaces(fetched.oldTypesEntry, fetched.newTypesEntry);
    const usage = scanPackageUsage(projectPath, bump.packageName, {
      followReexports: true,
    });
    const report = scoreRisk({
      packageName: bump.packageName,
      fromVersion: bump.fromVersion,
      toVersion: bump.toVersion,
      diff,
      usage,
      typesSource: fetched.typesSource,
      semverWeighting: true,
    });
    reports.push(report);
    console.log(formatMarkdownReport(report));
  }

  if (token && process.env.GITHUB_EVENT_PATH) {
    await maybeCommentOnPr(token, reports);
  }

  const worst = worstLevel(reports);
  if (failOn === "high" && worst === "HIGH") process.exitCode = 2;
  if (failOn === "medium" && (worst === "HIGH" || worst === "MEDIUM")) {
    process.exitCode = worst === "HIGH" ? 2 : 1;
  }
}

function worstLevel(reports: RiskReport[]): "HIGH" | "MEDIUM" | "LOW" {
  if (reports.some((r) => r.level === "HIGH")) return "HIGH";
  if (reports.some((r) => r.level === "MEDIUM")) return "MEDIUM";
  return "LOW";
}

async function maybeCommentOnPr(token: string, reports: RiskReport[]): Promise<void> {
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) as {
      pull_request?: { number: number };
      repository?: { full_name?: string };
    };
    const pr = event.pull_request?.number;
    const repo = process.env.GITHUB_REPOSITORY ?? event.repository?.full_name;
    if (!pr || !repo) return;

    const body = [
      "<!-- deprisk-bot -->",
      ...reports.map(formatMarkdownReport),
    ].join("\n\n---\n\n");

    const url = `https://api.github.com/repos/${repo}/issues/${pr}/comments`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      console.warn(`Failed to post PR comment: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`PR comment skipped: ${err instanceof Error ? err.message : err}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
