# DepRisk

CLI that tells you whether an npm dependency update is actually risky — not by reading changelogs, but by checking whether the specific exports your project calls were changed, deprecated, or removed.

Dependabot/Renovate say "this package went from v4 → v5." DepRisk answers: "did the parts *you* use change?"

## Install

```bash
# scaffold GitHub Action in any project
npx create-deprisk

# run checks
npx -p deprisk-check deprisk check <package> --from <old> --to <new>

# or install the CLI
pnpm add -D deprisk-check
```

Requires Node.js 18+. Package names: **`create-deprisk`** (scaffold) and **`deprisk-check`** (CLI). Binary: **`deprisk`**.

## Usage

```bash
# Single package (manual versions)
deprisk check lodash --from 4.17.20 --to 4.17.21 --path ./my-app

# Single package: locked version vs npm latest (no --from/--to needed)
deprisk check axios --latest --path ./my-app

# Audit: every direct dependency in package-lock.json vs npm latest
deprisk scan --latest --path ./my-app

# Audit including every top-level lockfile package
deprisk scan --latest --all

# PR mode: all bumps vs main
deprisk scan --base-ref origin/main
```

### Audit lockfile against latest (`deprisk scan --latest`)

Reads versions from `package-lock.json`, looks up npm **latest** for each package, and runs DepRisk for **locked → latest**.

| Flag | Description |
|------|-------------|
| `--latest` | Enable lockfile → latest audit |
| `--all` | All top-level lockfile packages (default: direct deps only) |
| `--no-include-dev` | Skip `devDependencies` |
| `--path <dir>` | Project root |
| `--json` / `--markdown` | Machine / PR output |
| `--fail-on high\|medium` | Gate on worst risk |

Packages already on latest are reported as `UP_TO_DATE` (not re-analyzed).

### Single package vs latest (`deprisk check <pkg> --latest`)

Same idea for one dependency — no need to type versions:

```bash
deprisk check axios --latest
# optional: override the locked “from” version
deprisk check axios --from 0.27.2 --latest
```

| Flag | Description |
|------|-------------|
| `--latest` | Compare locked (or `--from`) version to npm latest |
| `--from <version>` | Optional override instead of lockfile |
| `--path <dir>` | Project with `package-lock.json` |

### PR bump scan (`deprisk scan --base-ref` / `--base-lock`)

| Flag | Description |
|------|-------------|
| `--base-lock <file>` | Base branch lockfile |
| `--base-ref <git-ref>` | e.g. `origin/main` |
| `--head-lock <file>` | Head lockfile (default: `./package-lock.json`) |

### `deprisk check` options

| Flag | Description |
|------|-------------|
| `--from <version>` | Old version (or override with `--latest`) |
| `--to <version>` | New version (omit when using `--latest`) |
| `--latest` | Compare locked/`--from` version to npm latest |
| `--path <dir>` | Project to scan (default: cwd) |
| `--verbose` | Print full old/new signatures for flagged exports |
| `--json` | Emit machine-readable `RiskReport` |
| `--markdown` | Emit Markdown (PR comments) |
| `--html <file>` | Write an HTML report |
| `--fail-on high\|medium\|error` | Exit non-zero when risk meets the threshold (`error` also fails on analysis errors) |
| `--follow-reexports` | Trace consumer barrel files |
| `--workspaces` | Also scan monorepo workspace packages |
| `--semver-weight` | Weight major-version bumps more heavily |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | LOW (or below `--fail-on` threshold) |
| `1` | MEDIUM (default) or runtime error |
| `2` | HIGH |

### `--fail-on`

Both `check` and `scan` accept `--fail-on`:

| Value | Fails the build on |
|-------|--------------------|
| `high` | HIGH only (analysis errors ignored) |
| `medium` | HIGH or MEDIUM (analysis errors ignored) |
| `error` | HIGH, MEDIUM, **or any analysis error** (untyped/fetch failures) |

Without `--fail-on`, exit is by risk (HIGH=2, MEDIUM=1, LOW=0); a scan that produces *only* errors and nothing analyzable still exits `1`. Use `--fail-on error` to gate CI on packages DepRisk couldn't analyze:

```bash
deprisk scan --latest --fail-on error
```

### Risk levels

- **HIGH** — a used export was removed, or 2+ used exports changed
- **MEDIUM** — exactly one used export changed
- **LOW** — nothing you use was touched (or the package isn't directly imported)

### DefinitelyTyped (`@types/*`)

If a package ships no `.d.ts`, DepRisk falls back to `@types/<package>`:

1. Exact `@types` version match when published  
2. Else highest `@types` version with the same **major**  
3. Else latest `@types` version  

### `.depriskignore`

```
# ignore an export everywhere
merge
# ignore for one package
lodash:get
```

## Renovate / Dependabot demo

```bash
cd renovate-demo
npx deprisk check vite --from 8.0.0 --to 8.1.0
npx deprisk check lodash --from 4.17.20 --to 4.17.21
npx deprisk check @vitejs/plugin-react --from 5.0.0 --to 6.0.3
```

## GitHub Action

**Easiest — from any project:**

```bash
cd your-project
npx create-deprisk
```

That creates `.github/workflows/deprisk.yml`. Commit and push it — DepRisk runs on dependency PRs.

Or with the main CLI:

```bash
npx -p deprisk-check deprisk init
deprisk init --force --fail-on medium
```

See also [`action.yml`](./action.yml) and [`create-deprisk/`](./create-deprisk/).

## How it works

1. **Fetcher** — downloads both versions (cached under `~/.deprisk/cache/`), with `@types/*` fallback  
2. **API Diff** — ts-morph `.d.ts` surface diff (default-export normalization)  
3. **Usage Scanner** — imports/requires (+ optional barrel re-exports / workspaces)  
4. **Risk Scorer** — intersects diff with usages (+ optional semver weighting)

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
```

## Benchmark corpus

See [benchmarks/CORPUS.md](./benchmarks/CORPUS.md).

## Out of scope

- Hosted dashboard / SaaS  
- Auto-fix or code-mod suggestions  
- Analyzing packages with **neither** bundled types nor `@types/*`

## 0.7.1

- `--fail-on error` — gate `check`/`scan` on any package DepRisk couldn't analyze (untyped/fetch errors), in addition to HIGH/MEDIUM. `high`/`medium` now ignore analysis errors.
- `--fail-on` values are validated (`high|medium|error`).

## 0.7.0

- `deprisk scan --latest` — audit `package-lock.json` versions against npm latest (API-usage risk)
- `deprisk check <pkg> --latest` — one package: locked → npm latest (no `--from`/`--to`)
- `deprisk scan --base-ref` / `--base-lock` — PR bump scan (restored alongside latest mode)

## License

MIT
