#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { fetchPackageVersions } from "./fetcher.js";
import { diffApiSurfaces } from "./apiDiff.js";
import { scanPackageUsage } from "./usageScanner.js";
import { scoreRisk } from "./riskScorer.js";
import type { RiskReport } from "./types.js";

const program = new Command();

program
  .name("deprisk")
  .description("Check whether an npm dependency update risks the APIs your project actually uses")
  .version("0.1.0");

program
  .command("check")
  .description("Compare two versions of a package against local usage")
  .argument("<package>", "npm package name")
  .requiredOption("--from <version>", "old version")
  .requiredOption("--to <version>", "new version")
  .option("--path <projectDir>", "project directory to scan", process.cwd())
  .option("--verbose", "print full old/new signatures for flagged entries", false)
  .option("--json", "print raw RiskReport as JSON", false)
  .action(async (packageName: string, opts: {
    from: string;
    to: string;
    path: string;
    verbose: boolean;
    json: boolean;
  }) => {
    try {
      await runCheck(packageName, opts);
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

async function runCheck(
  packageName: string,
  opts: { from: string; to: string; path: string; verbose: boolean; json: boolean },
): Promise<void> {
  if (!opts.json) {
    console.log(
      chalk.dim(`Scanning package API diff: ${packageName} ${opts.from} → ${opts.to}...`),
    );
  }

  const fetched = await fetchPackageVersions(packageName, opts.from, opts.to);

  if (fetched.kind === "untyped") {
    throw new Error(fetched.message);
  }

  const diff = diffApiSurfaces(fetched.oldTypesEntry, fetched.newTypesEntry);

  if (!opts.json) {
    console.log(chalk.dim(`Scanning local usage of "${packageName}" in ${opts.path}...`));
    console.log();
  }

  const usage = scanPackageUsage(opts.path, packageName);
  const report = scoreRisk({
    packageName,
    fromVersion: opts.from,
    toVersion: opts.to,
    diff,
    usage,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHumanReport(report, opts.verbose, opts.path);
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
