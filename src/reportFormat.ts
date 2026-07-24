import type { RiskLevel, RiskReport } from "./types.js";
import type { SkippedEntry, UpToDateEntry } from "./scan.js";

export interface ScanFormatInput {
  mode?: "bumps" | "latest";
  reports: RiskReport[];
  upToDate?: UpToDateEntry[];
  skipped?: SkippedEntry[];
  errors: { packageName: string; message: string }[];
  worstLevel: RiskLevel;
  verbose?: boolean;
  /** Show every UP_TO_DATE row (default: summarize count only) */
  showUpToDate?: boolean;
  /** Show every SKIPPED row in the main table (default: count + short list when verbose/includeSkipped) */
  includeSkipped?: boolean;
}

export interface ScanCounts {
  analyzed: number;
  high: number;
  medium: number;
  low: number;
  skipped: number;
  error: number;
  upToDate: number;
}

export function countScanStatuses(input: ScanFormatInput): ScanCounts {
  const reports = input.reports;
  return {
    analyzed: reports.length,
    high: reports.filter((r) => r.level === "HIGH").length,
    medium: reports.filter((r) => r.level === "MEDIUM").length,
    low: reports.filter((r) => r.level === "LOW").length,
    skipped: (input.skipped ?? []).length,
    error: input.errors.length,
    upToDate: (input.upToDate ?? []).length,
  };
}

/**
 * Human-readable summary table for `deprisk scan`.
 */
export function formatScanSummary(input: ScanFormatInput): string {
  const { reports, errors, worstLevel, verbose, mode } = input;
  const upToDate = input.upToDate ?? [];
  const skipped = input.skipped ?? [];
  const showUpToDate = Boolean(input.showUpToDate || verbose);
  const includeSkipped = Boolean(input.includeSkipped || verbose);
  const counts = countScanStatuses(input);
  const lines: string[] = [];
  const isLatest = mode === "latest";

  const total =
    counts.analyzed + counts.upToDate + counts.skipped + counts.error;

  if (isLatest) {
    lines.push(
      `DepRisk scan — latest audit (${total} package${total === 1 ? "" : "s"})`,
    );
  } else {
    lines.push(
      `DepRisk scan — ${counts.analyzed + counts.skipped + counts.error} bump${
        counts.analyzed + counts.skipped + counts.error === 1 ? "" : "s"
      }`,
    );
  }
  lines.push("");
  lines.push("Summary");
  lines.push(`  Analyzed:   ${counts.analyzed}`);
  lines.push(`  HIGH:       ${counts.high}`);
  lines.push(`  MEDIUM:     ${counts.medium}`);
  lines.push(`  LOW:        ${counts.low}`);
  lines.push(`  SKIPPED:    ${counts.skipped}`);
  lines.push(`  ERROR:      ${counts.error}`);
  lines.push(`  UP_TO_DATE: ${counts.upToDate}`);
  lines.push("");

  if (total === 0) {
    lines.push(
      isLatest
        ? "No packages found to audit."
        : "No dependency version bumps detected.",
    );
    return lines.join("\n");
  }

  const tableRows: {
    name: string;
    from: string;
    to: string;
    risk: string;
  }[] = [];

  for (const r of reports) {
    tableRows.push({
      name: r.packageName,
      from: r.fromVersion,
      to: r.toVersion,
      risk: r.level,
    });
  }
  if (showUpToDate) {
    for (const u of upToDate) {
      tableRows.push({
        name: u.packageName,
        from: u.version,
        to: u.version,
        risk: "UP_TO_DATE",
      });
    }
  }
  if (includeSkipped) {
    for (const s of skipped) {
      tableRows.push({
        name: s.packageName,
        from: s.fromVersion ?? "-",
        to: s.toVersion ?? "-",
        risk: "SKIPPED",
      });
    }
  }
  for (const e of errors) {
    tableRows.push({ name: e.packageName, from: "-", to: "-", risk: "ERROR" });
  }

  if (tableRows.length > 0) {
    const fromLabel = isLatest ? "LOCKED" : "FROM";
    const toLabel = isLatest ? "LATEST" : "TO";
    const pkgWidth = Math.max(7, ...tableRows.map((r) => r.name.length));
    const fromWidth = Math.max(fromLabel.length, ...tableRows.map((r) => r.from.length));
    const toWidth = Math.max(toLabel.length, ...tableRows.map((r) => r.to.length));

    lines.push(
      pad("PACKAGE", pkgWidth)
        + "  "
        + pad(fromLabel, fromWidth)
        + "  "
        + pad(toLabel, toWidth)
        + "  RISK",
    );
    for (const r of tableRows) {
      lines.push(
        pad(r.name, pkgWidth)
          + "  "
          + pad(r.from, fromWidth)
          + "  "
          + pad(r.to, toWidth)
          + "  "
          + r.risk,
      );
    }
  }

  if (!showUpToDate && upToDate.length > 0) {
    lines.push("");
    lines.push(
      `${upToDate.length} package${upToDate.length === 1 ? "" : "s"} already on latest `
        + `(pass --show-up-to-date to list).`,
    );
  }

  const flagged = reports.filter((r) => r.flagged.length > 0);
  if (flagged.length > 0 || verbose) {
    lines.push("");
    lines.push("Flagged:");
    for (const r of flagged) {
      for (const entry of r.flagged) {
        const locs = entry.usages.map((u) => `${u.filePath}:${u.line}`).join(", ");
        lines.push(`  ${r.packageName} — ${entry.name}(): ${entry.summary}`);
        lines.push(`      used at: ${locs}`);
      }
    }
    if (flagged.length === 0 && verbose) {
      lines.push("  (none)");
    }
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push("Skipped (no TypeScript types — not a failure):");
    const list = includeSkipped ? skipped : skipped.slice(0, 5);
    for (const s of list) {
      lines.push(`  ${s.packageName}: no bundled .d.ts or compatible @types/*`);
    }
    if (!includeSkipped && skipped.length > 5) {
      lines.push(`  … and ${skipped.length - 5} more (pass --include-skipped to list all)`);
    }
  }

  if (errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of errors) {
      lines.push(`  ${e.packageName}: ${e.message}`);
    }
  }

  lines.push("");
  lines.push(`RISK (worst): ${worstLevel}`);
  return lines.join("\n");
}

/**
 * Markdown summary for a multi-package scan (PR-friendly).
 */
export function formatScanMarkdown(input: ScanFormatInput): string {
  const { reports, errors, worstLevel, mode } = input;
  const upToDate = input.upToDate ?? [];
  const skipped = input.skipped ?? [];
  const showUpToDate = Boolean(input.showUpToDate || input.verbose);
  const includeSkipped = Boolean(input.includeSkipped || input.verbose);
  const counts = countScanStatuses(input);
  const isLatest = mode === "latest";

  const lines: string[] = [
    `## DepRisk Upgrade Analysis`,
    "",
    `**Worst risk:** \`${worstLevel}\`${isLatest ? " _(latest audit)_" : ""}`,
    "",
    "### Summary",
    "",
    `| Metric | Count |`,
    `| --- | ---: |`,
    `| Analyzed | ${counts.analyzed} |`,
    `| HIGH | ${counts.high} |`,
    `| MEDIUM | ${counts.medium} |`,
    `| LOW | ${counts.low} |`,
    `| SKIPPED | ${counts.skipped} |`,
    `| ERROR | ${counts.error} |`,
    `| UP_TO_DATE | ${counts.upToDate} |`,
    "",
  ];

  const ordered = [...reports].sort((a, b) => riskRank(b.level) - riskRank(a.level));

  if (ordered.length > 0 || errors.length > 0) {
    lines.push("### Packages", "");
    if (isLatest) {
      lines.push(`| Package | Locked | Latest | Risk |`, `| --- | --- | --- | --- |`);
      for (const r of ordered) {
        lines.push(
          `| \`${r.packageName}\` | \`${r.fromVersion}\` | \`${r.toVersion}\` | **${r.level}** |`,
        );
      }
      if (showUpToDate) {
        for (const u of upToDate) {
          lines.push(
            `| \`${u.packageName}\` | \`${u.version}\` | \`${u.version}\` | UP_TO_DATE |`,
          );
        }
      }
    } else {
      lines.push(`| Package | From | To | Risk |`, `| --- | --- | --- | --- |`);
      for (const r of ordered) {
        lines.push(
          `| \`${r.packageName}\` | \`${r.fromVersion}\` | \`${r.toVersion}\` | **${r.level}** |`,
        );
      }
    }
    for (const e of errors) {
      lines.push(`| \`${e.packageName}\` | - | - | ERROR |`);
    }
    if (includeSkipped) {
      for (const s of skipped) {
        lines.push(
          `| \`${s.packageName}\` | \`${s.fromVersion ?? "-"}\` | \`${s.toVersion ?? "-"}\` | SKIPPED |`,
        );
      }
    }
    lines.push("");
  }

  const high = reports.filter((r) => r.level === "HIGH" && r.flagged.length > 0);
  const medium = reports.filter((r) => r.level === "MEDIUM" && r.flagged.length > 0);

  if (high.length > 0) {
    lines.push("### High risk", "");
    for (const r of high) appendFlaggedMarkdown(lines, r);
  }
  if (medium.length > 0) {
    lines.push("### Medium risk", "");
    for (const r of medium) appendFlaggedMarkdown(lines, r);
  }

  if (skipped.length > 0 && !includeSkipped) {
    lines.push(
      `_${skipped.length} package(s) skipped (no TypeScript types). `
        + `Not counted as upgrade risk._`,
      "",
    );
  }

  if (errors.length > 0) {
    lines.push("### Errors", "");
    for (const e of errors) {
      lines.push(`- **${e.packageName}**: ${e.message}`);
    }
    lines.push("");
  }

  lines.push(
    worstLevel === "LOW"
      ? "_Recommendation: no used-API breakage detected in analyzed packages._"
      : "_Recommendation: review flagged exports before merging._",
  );

  return lines.join("\n");
}

function riskRank(level: RiskLevel): number {
  return level === "HIGH" ? 3 : level === "MEDIUM" ? 2 : 1;
}

function appendFlaggedMarkdown(lines: string[], r: RiskReport): void {
  lines.push(`#### \`${r.packageName}\` (\`${r.fromVersion}\` → \`${r.toVersion}\`)`, "");
  lines.push("Used API changes:", "");
  for (const entry of r.flagged) {
    const locs = entry.usages.map((u) => `\`${u.filePath}:${u.line}\``).join(", ");
    lines.push(`- \`${entry.name}()\`: ${entry.summary}`);
    lines.push(`  - Affected usage: ${locs}`);
  }
  lines.push("");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Format a RiskReport as a Markdown PR comment.
 */
export function formatMarkdownReport(report: RiskReport): string {
  const lines: string[] = [
    `## DepRisk Upgrade Analysis`,
    "",
    `**${report.packageName}** \`${report.fromVersion}\` → \`${report.toVersion}\``,
    "",
    `**Risk:** \`${report.level}\``,
    "",
  ];

  if (report.typesSource) {
    lines.push(
      `_Types: old=${report.typesSource.old}, new=${report.typesSource.new}_`,
      "",
    );
  }

  if (report.notImported) {
    lines.push("Package is not directly imported — treating as LOW risk.");
    return lines.join("\n");
  }

  if (report.flagged.length === 0) {
    lines.push("No used exports were changed, deprecated, or removed.");
    lines.push("");
    lines.push("_Recommendation: safe to review and merge from an API-usage perspective._");
  } else {
    lines.push(`### Used API changes (${report.flagged.length})`, "");
    for (const entry of report.flagged) {
      const locs = entry.usages.map((u) => `\`${u.filePath}:${u.line}\``).join(", ");
      lines.push(`- **${entry.name}** — ${entry.summary}`);
      lines.push(`  - used at: ${locs}`);
    }
    lines.push("");
    lines.push("_Recommendation: review before merging._");
  }

  if (report.unusedChangeCount > 0) {
    lines.push("");
    lines.push(
      `_Unused API changes (not imported): ${report.unusedChangeCount}._`,
    );
  }

  return lines.join("\n");
}

/**
 * Minimal HTML report for local viewing.
 */
export function formatHtmlReport(report: RiskReport): string {
  const color =
    report.level === "HIGH" ? "#b91c1c"
      : report.level === "MEDIUM" ? "#a16207"
        : "#15803d";

  const flagged = report.flagged
    .map((e) => {
      const locs = e.usages.map((u) => `${u.filePath}:${u.line}`).join(", ");
      return `<li><strong>${escapeHtml(e.name)}</strong> — ${escapeHtml(e.summary)}<br/><small>${escapeHtml(locs)}</small></li>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>DepRisk — ${escapeHtml(report.packageName)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: ${color}; }
    li { margin: 0.5rem 0; }
  </style>
</head>
<body>
  <h1>RISK: ${escapeHtml(report.level)}</h1>
  <p><strong>${escapeHtml(report.packageName)}</strong>
     ${escapeHtml(report.fromVersion)} → ${escapeHtml(report.toVersion)}</p>
  ${report.flagged.length ? `<ul>${flagged}</ul>` : "<p>No used exports were changed.</p>"}
  <p><small>Unused changes: ${report.unusedChangeCount}</small></p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
