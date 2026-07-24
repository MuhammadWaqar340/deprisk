# DepRisk commands

## `deprisk` (`deprisk-check`)

| Command | One-line use |
|---------|----------------|
| `deprisk init` | Scaffold a GitHub Actions workflow (`.github/workflows/deprisk.yml`). |
| `deprisk check <package> --from <A> --to <B>` | Check one package bump (A → B) against your project's used APIs. |
| `deprisk check <package> --latest` | Check one package: lockfile version → npm latest (no versions to type). |
| `deprisk check <package> --from <A> --latest` | Same as `--latest`, but override the locked “from” version. |
| `deprisk scan --latest` | Audit all direct deps: each lockfile version → npm latest (npm or pnpm). |
| `deprisk scan --latest --no-include-dev` | Same audit, production dependencies only. |
| `deprisk scan --latest --all` | Audit every top-level lockfile package. |
| `deprisk scan --base-ref origin/main` | PR mode: risk-check bumps vs a git base ref (npm or pnpm lockfile). |
| `deprisk scan --base-lock <file>` | PR mode: risk-check bumps vs a base lockfile (npm or pnpm; Yarn unsupported). |

### Shared flags (check / scan)

| Flag | One-line use |
|------|----------------|
| `--path <dir>` | Project root to scan (default: cwd). |
| `--json` | Machine-readable JSON output. |
| `--markdown` | Concise Markdown report (e.g. PR comments). |
| `--html <file>` | Write an HTML report (`check` only). |
| `--sarif <file>` | Write SARIF 2.1.0 results (`scan`). |
| `--verbose` | Extra detail; also lists UP_TO_DATE and SKIPPED. |
| `--deep` | Detailed call-site compatibility reasoning (also implied by `--verbose`). |
| `--show-up-to-date` | List packages already on latest. |
| `--include-skipped` | List untyped packages that were skipped. |
| `--fail-on high\|medium\|error` | Exit non-zero on risk threshold; `error` also fails on analysis ERROR (not SKIPPED). |
| `--follow-reexports` | Trace consumer barrel re-exports. |
| `--workspaces` | Also scan monorepo workspace packages. |
| `--semver-weight` | Weight major-version bumps more heavily. |
| `--head-lock <file>` | Head lockfile for PR scan (auto-detect npm/pnpm in `--path` if omitted). |

### Config

| File | One-line use |
|------|----------------|
| `.depriskrc.json` | Project defaults (`failOn`, `includeDev`, `showUpToDate`, `includeSkipped`, `all`, `concurrency`, …). CLI flags override. |

### Statuses (scan)

| Status | One-line meaning |
|--------|------------------|
| `HIGH` / `MEDIUM` / `LOW` | Usage-aware API risk |
| `UP_TO_DATE` | Already on npm latest (summarized by default) |
| `SKIPPED` | No types — cannot analyze; not a CI failure by default |
| `ERROR` | Fetch/parser failure |

## `create-deprisk`

| Command | One-line use |
|---------|----------------|
| `npx create-deprisk` | Scaffold the DepRisk GitHub Actions workflow in the current project. |
| `npx create-deprisk --force` | Overwrite an existing workflow file. |
| `npx create-deprisk --path <dir>` | Scaffold into another project directory. |
| `npx create-deprisk --fail-on medium` | Set the workflow risk failure threshold to medium. |
| `npx create-deprisk --output <file>` | Write the workflow to a custom path. |
