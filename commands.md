# DepRisk commands

## `deprisk` (`deprisk-check`)

| Command | One-line use |
|---------|----------------|
| `deprisk init` | Scaffold a GitHub Actions workflow (`.github/workflows/deprisk.yml`). |
| `deprisk check <package> --from <A> --to <B>` | Check one package bump (A → B) against your project's used APIs. |
| `deprisk check <package> --latest` | Check one package: lockfile version → npm latest (no versions to type). |
| `deprisk check <package> --from <A> --latest` | Same as `--latest`, but override the locked “from” version. |
| `deprisk scan --latest` | Audit all direct deps: each lockfile version → npm latest. |
| `deprisk scan --latest --no-include-dev` | Same audit, production dependencies only. |
| `deprisk scan --latest --all` | Audit every top-level package in `package-lock.json`. |
| `deprisk scan --base-ref origin/main` | PR mode: risk-check bumps vs a git base ref. |
| `deprisk scan --base-lock <file>` | PR mode: risk-check bumps vs a base `package-lock.json`. |

### Shared flags (check / scan)

| Flag | One-line use |
|------|----------------|
| `--path <dir>` | Project root to scan (default: cwd). |
| `--json` | Machine-readable JSON output. |
| `--markdown` | Markdown report (e.g. PR comments). |
| `--html <file>` | Write an HTML report (`check` only). |
| `--verbose` | Show full old/new signatures for flagged exports. |
| `--fail-on high\|medium\|error` | Exit non-zero when risk meets the threshold; `error` also fails on any package that couldn't be analyzed. |
| `--follow-reexports` | Trace consumer barrel re-exports. |
| `--workspaces` | Also scan monorepo workspace packages. |
| `--semver-weight` | Weight major-version bumps more heavily. |
| `--head-lock <file>` | Head lockfile for PR scan (default: `<path>/package-lock.json`). |

## `create-deprisk`

| Command | One-line use |
|---------|----------------|
| `npx create-deprisk` | Scaffold the DepRisk GitHub Actions workflow in the current project. |
| `npx create-deprisk --force` | Overwrite an existing workflow file. |
| `npx create-deprisk --path <dir>` | Scaffold into another project directory. |
| `npx create-deprisk --fail-on medium` | Set the workflow risk failure threshold to medium. |
| `npx create-deprisk --output <file>` | Write the workflow to a custom path. |
