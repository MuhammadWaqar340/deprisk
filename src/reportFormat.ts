import type { RiskReport } from "./types.js";

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
