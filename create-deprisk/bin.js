#!/usr/bin/env node

/**
 * npx create-deprisk
 * Scaffolds .github/workflows/deprisk.yml in the current (or --path) project.
 */
import { initGitHubWorkflow } from "deprisk-check";

function parseArgs(argv) {
  const opts = {
    path: process.cwd(),
    force: false,
    failOn: "high",
    output: ".github/workflows/deprisk.yml",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--force" || arg === "-f") opts.force = true;
    else if (arg === "--path" || arg === "-p") opts.path = argv[++i] ?? opts.path;
    else if (arg === "--fail-on") {
      const v = argv[++i];
      opts.failOn = v === "medium" ? "medium" : "high";
    } else if (arg === "--output" || arg === "-o") opts.output = argv[++i] ?? opts.output;
  }

  return opts;
}

function printHelp() {
  console.log(`create-deprisk — scaffold a DepRisk GitHub Actions workflow

Usage:
  npx create-deprisk
  npx create-deprisk --force
  npx create-deprisk --path ./my-app --fail-on medium

Options:
  --path, -p <dir>       Project directory (default: cwd)
  --force, -f            Overwrite existing workflow
  --fail-on <high|medium>  PR check failure threshold (default: high)
  --output, -o <file>    Workflow path (default: .github/workflows/deprisk.yml)
  --help, -h             Show help
`);
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  printHelp();
  process.exit(0);
}

const result = initGitHubWorkflow({
  path: opts.path,
  force: opts.force,
  failOn: opts.failOn,
  output: opts.output,
  packageVersion: "0.7.1",
});

if (result.skipped) {
  console.error(`⚠  ${result.message}`);
  process.exit(1);
}

console.log(`✓ ${result.message}`);
console.log();
console.log("Next steps:");
console.log("  1. git add .github/workflows/deprisk.yml");
console.log("  2. git commit -m \"Add DepRisk GitHub Action\"");
console.log("  3. git push — then open a dependency PR to see it run");
console.log(`  4. File: ${result.filePath}`);
