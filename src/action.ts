/**
 * GitHub Action entry — runs DepRisk and optionally comments on the PR.
 * Designed to be invoked via action.yml (node20).
 */
import fs from "node:fs";
import path from "node:path";
import { runAction, formatActionReports } from "./actionRun.js";
import { formatMarkdownReport } from "./reportFormat.js";

function getInput(name: string, fallback = ""): string {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return (process.env[key] ?? fallback).trim();
}

async function main(): Promise<void> {
  const projectPath = path.resolve(getInput("path", "."));
  const result = await runAction({
    projectPath,
    failOnRaw: getInput("fail-on", "high"),
    packageFilter: getInput("package") || undefined,
    from: getInput("from") || undefined,
    to: getInput("to") || undefined,
    baseLock: getInput("base-lockfile") || undefined,
    headLock: getInput("head-lockfile") || undefined,
  });

  if (result.reports.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    console.log("No dependency version bumps detected — nothing to check.");
  }

  for (const report of result.reports) {
    console.log(
      `Checking ${report.packageName} ${report.fromVersion} → ${report.toVersion}`,
    );
    console.log(formatMarkdownReport(report));
  }
  for (const s of result.skipped) {
    console.warn(`Skipped ${s.packageName}: ${s.message}`);
  }
  for (const e of result.errors) {
    console.error(`Error ${e.packageName}: ${e.message}`);
  }

  const token = getInput("github-token", process.env.GITHUB_TOKEN ?? "");
  if (token && process.env.GITHUB_EVENT_PATH && result.reports.length > 0) {
    await maybeCommentOnPr(token, result.reports);
  }

  if (result.exitCode) process.exitCode = result.exitCode;
}

async function maybeCommentOnPr(
  token: string,
  reports: Parameters<typeof formatActionReports>[0],
): Promise<void> {
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) as {
      pull_request?: { number: number };
      repository?: { full_name?: string };
    };
    const pr = event.pull_request?.number;
    const repo = process.env.GITHUB_REPOSITORY ?? event.repository?.full_name;
    if (!pr || !repo) return;

    const body = ["<!-- deprisk-bot -->", formatActionReports(reports)].join("\n\n");
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
