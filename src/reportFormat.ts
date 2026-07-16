import type { RiskLevel, RiskReport } from "./types.js";
import type { UpToDateEntry } from "./scan.js";

export interface ScanFormatInput {
  mode?: "bumps" | "latest";
  reports: RiskReport[];
  upToDate?: UpToDateEntry[];
  errors: { packageName: string; message: string }[];
  worstLevel: RiskLevel;
  verbose?: boolean;
}

/**
 * Human-readable summary table for `deprisk scan`.
 */
export function formatScanSummary(input: ScanFormatInput): string {
  const { reports, errors, worstLevel, verbose, mode } = input;
  const upToDate = input.upToDate ?? [];
  const lines: string[] = [];

  const analyzed = reports.length;
  const totalListed = analyzed + upToDate.length + errors.length;
  const isLatest = mode === "latest";

  if (isLatest) {
    lines.push(
      `DepRisk scan — latest audit (${totalListed} package${totalListed === 1 ? "" : "s"}`
        + (upToDate.length ? `, ${upToDate.length} already latest` : "")
        + ")",
    );
  } else {
    lines.push(`DepRisk scan — ${analyzed + errors.length} bump${analyzed + errors.length === 1 ? "" : "s"}`);
  }
  lines.push("");

  if (totalListed === 0) {
    lines.push(
      isLatest
        ? "No packages found to audit."
        : "No dependency version bumps detected.",
    );
    return lines.join("\n");
  }

  if (isLatest) {
    const pkgWidth = Math.max(
      7,
      ...reports.map((r) => r.packageName.length),
      ...upToDate.map((u) => u.packageName.length),
      ...errors.map((e) => e.packageName.length),
    );
    const lockedWidth = Math.max(
      6,
      ...reports.map((r) => r.fromVersion.length),
      ...upToDate.map((u) => u.version.length),
      6,
    );
    const latestWidth = Math.max(
      6,
      ...reports.map((r) => r.toVersion.length),
      ...upToDate.map((u) => u.version.length),
      6,
    );

    lines.push(
      pad("PACKAGE", pkgWidth)
        + "  "
        + pad("LOCKED", lockedWidth)
        + "  "
        + pad("LATEST", latestWidth)
        + "  RISK",
    );

    for (const r of reports) {
      lines.push(
        pad(r.packageName, pkgWidth)
          + "  "
          + pad(r.fromVersion, lockedWidth)
          + "  "
          + pad(r.toVersion, latestWidth)
          + "  "
          + r.level,
      );
    }
    for (const u of upToDate) {
      lines.push(
        pad(u.packageName, pkgWidth)
          + "  "
          + pad(u.version, lockedWidth)
          + "  "
          + pad(u.version, latestWidth)
          + "  UP_TO_DATE",
      );
    }
    for (const e of errors) {
      lines.push(
        pad(e.packageName, pkgWidth)
          + "  "
          + pad("-", lockedWidth)
          + "  "
          + pad("-", latestWidth)
          + "  ERROR",
      );
    }
  } else {
    const pkgWidth = Math.max(
      7,
      ...reports.map((r) => r.packageName.length),
      ...errors.map((e) => e.packageName.length),
    );
    const fromWidth = Math.max(4, ...reports.map((r) => r.fromVersion.length), 8);
    const toWidth = Math.max(2, ...reports.map((r) => r.toVersion.length), 8);

    lines.push(
      pad("PACKAGE", pkgWidth)
        + "  "
        + pad("FROM", fromWidth)
        + "  "
        + pad("TO", toWidth)
        + "  RISK",
    );

    for (const r of reports) {
      lines.push(
        pad(r.packageName, pkgWidth)
          + "  "
          + pad(r.fromVersion, fromWidth)
          + "  "
          + pad(r.toVersion, toWidth)
          + "  "
          + r.level,
      );
    }
    for (const e of errors) {
      lines.push(
        pad(e.packageName, pkgWidth)
          + "  "
          + pad("-", fromWidth)
          + "  "
          + pad("-", toWidth)
          + "  ERROR",
      );
    }
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
  const isLatest = mode === "latest";
  const emoji =
    worstLevel === "HIGH" ? "🔴"
      : worstLevel === "MEDIUM" ? "🟡"
        : "🟢";

  const lines: string[] = [
    `## DepRisk scan ${emoji} \`${worstLevel}\`${isLatest ? " (latest audit)" : ""}`,
    "",
  ];

  if (isLatest) {
    lines.push(`| Package | Locked | Latest | Risk |`, `| --- | --- | --- | --- |`);
    for (const r of reports) {
      lines.push(
        `| \`${r.packageName}\` | \`${r.fromVersion}\` | \`${r.toVersion}\` | **${r.level}** |`,
      );
    }
    for (const u of upToDate) {
      lines.push(
        `| \`${u.packageName}\` | \`${u.version}\` | \`${u.version}\` | UP_TO_DATE |`,
      );
    }
  } else {
    lines.push(`| Package | From | To | Risk |`, `| --- | --- | --- | --- |`);
    for (const r of reports) {
      lines.push(
        `| \`${r.packageName}\` | \`${r.fromVersion}\` | \`${r.toVersion}\` | **${r.level}** |`,
      );
    }
  }

  for (const e of errors) {
    lines.push(`| \`${e.packageName}\` | - | - | ERROR |`);
  }

  const flagged = reports.filter((r) => r.flagged.length > 0);
  if (flagged.length > 0) {
    lines.push("", "### Flagged exports", "");
    for (const r of flagged) {
      lines.push(`#### ${r.packageName}`, "");
      for (const entry of r.flagged) {
        const locs = entry.usages.map((u) => `\`${u.filePath}:${u.line}\``).join(", ");
        lines.push(`- **${entry.name}** — ${entry.summary}`);
        lines.push(`  - used at: ${locs}`);
      }
      lines.push("");
    }
  }

  if (errors.length > 0) {
    lines.push("### Errors", "");
    for (const e of errors) {
      lines.push(`- **${e.packageName}**: ${e.message}`);
    }
  }

  return lines.join("\n");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Format a RiskReport as a Markdown PR comment.
 */
export function formatMarkdownReport(report: RiskReport): string {
  const emoji =
    report.level === "HIGH" ? "🔴"
      : report.level === "MEDIUM" ? "🟡"
        : "🟢";

  const lines: string[] = [
    `## DepRisk ${emoji} \`${report.level}\``,
    "",
    `**${report.packageName}** \`${report.fromVersion}\` → \`${report.toVersion}\``,
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
  } else {
    lines.push(`### Flagged exports (${report.flagged.length})`);
    lines.push("");
    for (const entry of report.flagged) {
      const locs = entry.usages.map((u) => `\`${u.filePath}:${u.line}\``).join(", ");
      lines.push(`- **${entry.name}** — ${entry.summary}`);
      lines.push(`  - used at: ${locs}`);
    }
  }

  if (report.unusedChangeCount > 0) {
    lines.push("");
    lines.push(
      `_Unused changes (safe to ignore): ${report.unusedChangeCount} other export(s)._`,
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
