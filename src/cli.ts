#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  formatMarkdownReport,
  formatHtmlReport,
  formatScanSummary,
  formatScanMarkdown,
} from "./reportFormat.js";
import { initGitHubWorkflow } from "./init.js";
import { analyzePackage, runScan } from "./scan.js";
import { resolveCheckVersions } from "./checkResolve.js";
import type { RiskLevel, RiskReport } from "./types.js";

const VERSION = "0.7.0";

const program = new Command();

program
  .name("deprisk")
  .description("Check whether an npm dependency update risks the APIs your project actually uses")
  .version(VERSION);

program
  .command("init")
  .description("Create a GitHub Actions workflow (.github/workflows/deprisk.yml)")
  .option("--path <projectDir>", "project directory", process.cwd())
  .option("--force", "overwrite an existing workflow file", false)
  .option("--fail-on <level>", "fail the PR check when risk is at least: high|medium", "high")
  .option("--output <file>", "workflow path relative to project", ".github/workflows/deprisk.yml")
  .action((opts: {
    path: string;
    force: boolean;
    failOn: string;
    output: string;
  }) => {
    const failOn = opts.failOn === "medium" ? "medium" : "high";
    const result = initGitHubWorkflow({
      path: opts.path,
      force: opts.force,
      failOn,
      output: opts.output,
      packageVersion: VERSION,
    });

    if (result.skipped) {
      console.log(chalk.yellow(result.message));
      process.exitCode = 1;
      return;
    }

    console.log(chalk.green(`✓ ${result.message}`));
    console.log();
    console.log(chalk.dim("Next steps:"));
    console.log(chalk.dim("  1. Commit and push the workflow file"));
    console.log(chalk.dim("  2. Open a dependency PR (Renovate/Dependabot) to see DepRisk run"));
    console.log(chalk.dim(`  3. File: ${result.filePath}`));
  });

program
  .command("scan")
  .description(
    "Scan dependency bumps (PR mode) or audit lockfile vs npm latest (--latest)",
  )
  .option("--path <projectDir>", "project directory to scan", process.cwd())
  .option("--latest", "audit: compare each package's locked version to npm latest", false)
  .option("--all", "with --latest: include every top-level lockfile package", false)
  .option("--base-lock <file>", "PR mode: base package-lock.json")
  .option("--base-ref <git-ref>", "PR mode: git ref for base lockfile (e.g. origin/main)")
  .option("--head-lock <file>", "PR mode: head package-lock.json (default: <path>/package-lock.json)")
  .option("--fail-on <level>", "exit non-zero when worst risk is at least: high|medium")
  .option("--json", "print scan result as JSON", false)
  .option("--markdown", "print Markdown scan summary", false)
  .option("--verbose", "show extra flagged details", false)
  .option("--include-dev", "include devDependency packages (default: true)", true)
  .option("--no-include-dev", "only production dependencies")
  .option("--follow-reexports", "trace consumer barrel re-exports", false)
  .option("--workspaces", "also scan workspace packages (monorepo)", false)
  .option("--semver-weight", "weight major bumps more heavily in scoring", false)
  .action(async (opts: {
    path: string;
    latest: boolean;
    all: boolean;
    baseLock?: string;
    baseRef?: string;
    headLock?: string;
    failOn?: string;
    json: boolean;
    markdown: boolean;
    verbose: boolean;
    includeDev: boolean;
    followReexports: boolean;
    workspaces: boolean;
    semverWeight: boolean;
  }) => {
    try {
      if (opts.latest && (opts.baseLock || opts.baseRef)) {
        throw new Error(
          "Use either --latest (audit) or --base-lock/--base-ref (PR bumps), not both.",
        );
      }
      if (!opts.latest && !opts.baseLock && !opts.baseRef) {
        throw new Error(
          "Pass --latest, or --base-lock <file>, or --base-ref <git-ref> (e.g. origin/main).",
        );
      }
      if (opts.all && !opts.latest) {
        throw new Error("--all is only valid with --latest.");
      }

      const result = await runScan({
        path: opts.path,
        latest: opts.latest,
        all: opts.all,
        baseLock: opts.baseLock,
        baseRef: opts.baseRef,
        headLock: opts.headLock,
        includeDev: opts.includeDev,
        followReexports: opts.followReexports,
        workspaces: opts.workspaces,
        semverWeight: opts.semverWeight,
        onBump: (bump, index, total) => {
          if (!opts.json && !opts.markdown) {
            console.error(
              chalk.dim(
                `[${index + 1}/${total}] ${bump.packageName} ${bump.fromVersion} → ${bump.toVersion}`,
              ),
            );
          }
        },
      });

      if (opts.json) {
        console.log(JSON.stringify({
          mode: result.mode,
          worstLevel: result.worstLevel,
          reports: result.reports,
          upToDate: result.upToDate,
          errors: result.errors,
        }, null, 2));
      } else if (opts.markdown) {
        console.log(formatScanMarkdown({
          mode: result.mode,
          reports: result.reports,
          upToDate: result.upToDate,
          errors: result.errors,
          worstLevel: result.worstLevel,
          verbose: opts.verbose,
        }));
      } else {
        console.log();
        console.log(formatScanSummary({
          mode: result.mode,
          reports: result.reports,
          upToDate: result.upToDate,
          errors: result.errors,
          worstLevel: result.worstLevel,
          verbose: opts.verbose,
        }));
      }

      if (result.errors.length > 0 && result.reports.length === 0 && !opts.failOn) {
        process.exitCode = 1;
      }

      applyExitCode(result.worstLevel, opts.failOn);
      if (opts.failOn && result.errors.length > 0 && !process.exitCode) {
        process.exitCode = 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error(chalk.red(`Error: ${message}`));
      }
      process.exitCode = 1;
    }
  });

program
  .command("check")
  .description("Compare two versions of a package against local usage")
  .argument("<package>", "npm package name")
  .option("--from <version>", "old version (lockfile if omitted with --latest)")
  .option("--to <version>", "new version (required unless --latest)")
  .option(
    "--latest",
    "compare locked (or --from) version to npm latest — no --to needed",
    false,
  )
  .option("--path <projectDir>", "project directory to scan", process.cwd())
  .option("--verbose", "print full old/new signatures for flagged entries", false)
  .option("--json", "print raw RiskReport as JSON", false)
  .option("--markdown", "print Markdown report (for PR comments)", false)
  .option("--html <file>", "write an HTML report to a file")
  .option("--fail-on <level>", "exit non-zero when risk is at least this level: high|medium")
  .option("--follow-reexports", "trace consumer barrel re-exports", false)
  .option("--workspaces", "also scan workspace packages (monorepo)", false)
  .option("--semver-weight", "weight major bumps more heavily in scoring", false)
  .action(async (packageName: string, opts: {
    from?: string;
    to?: string;
    latest: boolean;
    path: string;
    verbose: boolean;
    json: boolean;
    markdown: boolean;
    html?: string;
    failOn?: string;
    followReexports: boolean;
    workspaces: boolean;
    semverWeight: boolean;
  }) => {
    try {
      const report = await runCheck(packageName, opts);
      applyExitCode(report.level, opts.failOn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error(chalk.red(`Error: ${message}`));
      }
      process.exitCode = 1;
    }
  });

export async function runCheck(
  packageName: string,
  opts: {
    from?: string;
    to?: string;
    latest?: boolean;
    path: string;
    verbose?: boolean;
    json?: boolean;
    markdown?: boolean;
    html?: string;
    failOn?: string;
    followReexports?: boolean;
    workspaces?: boolean;
    semverWeight?: boolean;
    /** Injectable for tests */
    resolveLatest?: (name: string) => Promise<string>;
  },
): Promise<RiskReport> {
  const { fromVersion, toVersion, upToDate } = await resolveCheckVersions(packageName, {
    path: opts.path,
    from: opts.from,
    to: opts.to,
    latest: opts.latest,
    resolveLatest: opts.resolveLatest,
  });

  if (upToDate && opts.latest) {
    const report: RiskReport = {
      packageName,
      fromVersion,
      toVersion,
      level: "LOW",
      flagged: [],
      unusedChangeCount: 0,
      notImported: false,
    };

    if (opts.json) {
      console.log(JSON.stringify({ ...report, upToDate: true }, null, 2));
    } else if (opts.markdown) {
      console.log(formatMarkdownReport(report));
      console.log(`\n_Already on latest (${toVersion})._`);
    } else {
      console.log(
        chalk.green(
          `✓ ${packageName} is already on latest (${toVersion}) — nothing to check.`,
        ),
      );
      console.log();
      console.log(`${chalk.bold("RISK:")} ${chalk.green.bold("LOW")} ${chalk.dim("(UP_TO_DATE)")}`);
    }
    return report;
  }

  if (!opts.json && !opts.markdown) {
    console.log(
      chalk.dim(`Scanning package API diff: ${packageName} ${fromVersion} → ${toVersion}...`),
    );
  }

  const report = await analyzePackage(packageName, fromVersion, toVersion, {
    path: opts.path,
    followReexports: opts.followReexports,
    workspaces: opts.workspaces,
    semverWeight: opts.semverWeight,
  });

  if (!opts.json && !opts.markdown && report.typesSource) {
    const src = report.typesSource;
    if (src.old === "definitelyTyped" || src.new === "definitelyTyped") {
      console.log(
        chalk.dim(
          `Types source: old=${src.old}, new=${src.new} (DefinitelyTyped fallback)`,
        ),
      );
    }
    console.log(chalk.dim(`Scanning local usage of "${packageName}" in ${opts.path}...`));
    console.log();
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (opts.markdown) {
    console.log(formatMarkdownReport(report));
  } else {
    printHumanReport(report, Boolean(opts.verbose), opts.path);
  }

  if (opts.html) {
    const out = path.resolve(opts.html);
    fs.writeFileSync(out, formatHtmlReport(report), "utf8");
    if (!opts.json && !opts.markdown) {
      console.log(chalk.dim(`HTML report written to ${out}`));
    }
  }

  return report;
}

function applyExitCode(level: RiskLevel, failOn?: string): void {
  if (failOn === "high") {
    if (level === "HIGH") process.exitCode = 2;
    return;
  }
  if (failOn === "medium") {
    if (level === "HIGH") process.exitCode = 2;
    else if (level === "MEDIUM") process.exitCode = 1;
    return;
  }

  if (level === "HIGH") process.exitCode = 2;
  else if (level === "MEDIUM") process.exitCode = 1;
}

function printHumanReport(report: RiskReport, verbose: boolean, projectPath: string): void {
  const levelColor =
    report.level === "HIGH" ? chalk.red
      : report.level === "MEDIUM" ? chalk.yellow
        : chalk.green;

  console.log(`${chalk.bold("RISK:")} ${levelColor.bold(report.level)}`);
  console.log();

  if (report.notImported) {
    console.log(
      chalk.dim(`Package "${report.packageName}" is not directly imported in ${projectPath}.`),
    );
    console.log(chalk.dim("Nothing to flag — treating as LOW risk."));
    return;
  }

  if (report.flagged.length === 0) {
    console.log(chalk.green("No used exports were changed, deprecated, or removed."));
  } else {
    const label =
      report.flagged.length === 1
        ? "Changed export you use (1):"
        : `Changed exports you use (${report.flagged.length}):`;
    console.log(chalk.bold(label));

    for (const entry of report.flagged) {
      const mark = chalk.red("✗");
      console.log(`  ${mark} ${chalk.bold(entry.name + "()")}  — ${entry.summary}`);
      const locations = entry.usages
        .map((u) => `${u.filePath}:${u.line}`)
        .join(", ");
      console.log(chalk.dim(`      used at: ${locations}`));

      if (verbose) {
        if (entry.oldSignature) {
          console.log(chalk.dim(`      old: ${entry.oldSignature}`));
        }
        if (entry.newSignature) {
          console.log(chalk.dim(`      new: ${entry.newSignature}`));
        }
      }
    }
  }

  console.log();
  if (report.unusedChangeCount > 0) {
    console.log(
      chalk.dim(
        `Unused changes (safe to ignore): ${report.unusedChangeCount} other export(s) changed but are not used in this project.`,
      ),
    );
  }

  if (!verbose && report.flagged.length > 0) {
    console.log();
    console.log(
      chalk.dim(
        `Run \`deprisk check ${report.packageName} --from ${report.fromVersion} --to ${report.toVersion} --verbose\` for full diffs.`,
      ),
    );
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Error: ${message}`));
  process.exitCode = 1;
});
