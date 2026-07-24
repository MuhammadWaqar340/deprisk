# DepRisk

DepRisk analyzes dependency upgrades against your actual TypeScript/JavaScript usage.

It does **not** simply ask: “Did the package change?”  
It asks: “Did something my code actually uses change — and is that usage still compatible?”

```text
API changed
        ↓
DepRisk checks actual usage + call sites
        ↓
Usage remains compatible
        ↓
LOW risk
```

```text
API changed
        ↓
DepRisk checks actual usage + call sites
        ↓
Usage is incompatible (e.g. extra argument no longer accepted)
        ↓
HIGH risk
```

A major bump can be LOW if you don’t use the breaking APIs **or** your call sites still fit the new signatures. A small bump can be HIGH if your specific usage breaks.

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

# Audit: direct deps vs npm latest (npm or pnpm lockfile)
deprisk scan --latest --path ./my-app

# Audit including every top-level lockfile package
deprisk scan --latest --all

# PR mode: all bumps vs main (npm package-lock.json)
deprisk scan --base-ref origin/main --markdown --sarif deprisk.sarif
```

### Audit lockfile against latest (`deprisk scan --latest`)

Reads locked versions from **`package-lock.json` or `pnpm-lock.yaml`**, looks up npm **latest**, and runs DepRisk for **locked → latest**.

If both lockfiles exist, DepRisk prefers **pnpm** and prints a warning.

| Flag | Description |
|------|-------------|
| `--latest` | Enable lockfile → latest audit |
| `--all` | All top-level lockfile packages (default: direct deps only) |
| `--no-include-dev` | Skip `devDependencies` |
| `--path <dir>` | Project root |
| `--json` / `--markdown` | Machine / PR output |
| `--sarif <file>` | Write SARIF 2.1.0 results |
| `--show-up-to-date` | List UP_TO_DATE packages (hidden by default) |
| `--include-skipped` | List SKIPPED untyped packages in the table |
| `--deep` | Detailed call-site compatibility reasoning (`--verbose` also expands this) |
| `--fail-on high\|medium\|error` | Gate on worst risk / errors |

Default output shows a **Summary** (counts for HIGH/MEDIUM/LOW/SKIPPED/ERROR/UP_TO_DATE) plus analyzed packages. Packages already on latest are counted, not listed, unless `--show-up-to-date` / `--verbose`.

### Statuses

| Status | Meaning |
|--------|---------|
| **HIGH / MEDIUM / LOW** | Usage-aware risk from **compatibility evidence** (not raw change counts) |
| **UP_TO_DATE** | Locked version === npm latest (not re-analyzed) |
| **SKIPPED** | No bundled `.d.ts` and no usable `@types/*` — cannot API-diff; **not** a CI failure by default |
| **ERROR** | Network/fetch/parser failure or unexpected analysis error |

### Compatibility (Phase 2)

DepRisk separates **API change detection** from **usage compatibility**:

| Compatibility | Meaning | Typical risk |
|---------------|---------|--------------|
| `COMPATIBLE` | Change exists, but your call sites still fit | LOW |
| `INCOMPATIBLE` | Proven break at a call site (arity, removed prop/method, …) | HIGH |
| `POTENTIALLY_INCOMPATIBLE` | Likely issue (e.g. return became nullable without a null check) | MEDIUM |
| `UNKNOWN` | Cannot prove either way | never auto-HIGH |
| `NOT_USED` | No used changed exports | LOW |

**Confidence:** `HIGH` / `MEDIUM` / `LOW` / `UNKNOWN` — how deterministic the finding is.

Deep analysis runs by default. Use `--deep` or `--verbose` for full signatures and recommendations.

**Limits:** Phase 2 is static TypeScript/JavaScript usage analysis. It does **not** prove runtime behavior, performance, network, or semantic equivalence.

### Single package vs latest (`deprisk check <pkg> --latest`)

```bash
deprisk check axios --latest
deprisk check axios --from 0.27.2 --latest
```

### PR bump scan (`deprisk scan --base-ref` / `--base-lock`)

Currently supports **npm `package-lock.json` and pnpm `pnpm-lock.yaml`** for base/head diffs. Yarn is not supported for PR mode.

| Flag | Description |
|------|-------------|
| `--base-lock <file>` | Base branch lockfile |
| `--base-ref <git-ref>` | e.g. `origin/main` |
| `--head-lock <file>` | Head lockfile (default: `./package-lock.json`) |

### Configuration (`.depriskrc.json`)

Optional project config. **CLI flags always override** the file.

```json
{
  "failOn": "high",
  "includeDev": true,
  "followReexports": false,
  "workspaces": false,
  "semverWeight": false,
  "showUpToDate": false,
  "includeSkipped": false,
  "all": false,
  "concurrency": 4
}
```

Also accepts `.depriskrc` (same JSON). Unknown keys or invalid values fail with a clear error.

### SARIF output

```bash
deprisk scan --latest --sarif deprisk-results.sarif
deprisk scan --base-ref origin/main --markdown --sarif deprisk-results.sarif
```

Writes [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) with rule IDs such as `DEP-RISK-HIGH`, `DEP-RISK-MEDIUM`, `DEP-RISK-API-REMOVED`, `DEP-RISK-API-CHANGED`, including package versions and `file:line` when available. DepRisk structurally validates emitted SARIF; treat GitHub Code Scanning upload as something to verify in your own CI rather than a guaranteed integration.

### Supported lockfiles

| Feature | npm `package-lock.json` | pnpm `pnpm-lock.yaml` | Yarn `yarn.lock` |
|---------|-------------------------|------------------------|------------------|
| `check … --latest` (locked version) | Yes | Yes | Partial |
| `scan --latest` | Yes | Yes | Not yet |
| `scan --base-ref` / `--base-lock` (PR) | Yes | Yes | Not yet |

If multiple lockfiles exist, DepRisk prefers **pnpm → npm → yarn** and prints a warning.

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
| `--fail-on high\|medium\|error` | Exit non-zero when risk meets the threshold |
| `--follow-reexports` | Trace consumer barrel files |
| `--workspaces` | Also scan monorepo workspace packages |
| `--semver-weight` | Weight major-version bumps more heavily |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | LOW (or below `--fail-on` threshold) |
| `1` | MEDIUM (default) or runtime / analysis ERROR |
| `2` | HIGH |

### `--fail-on`

| Value | Fails the build on |
|-------|--------------------|
| `high` | HIGH only (SKIPPED and ERROR ignored) |
| `medium` | HIGH or MEDIUM (SKIPPED ignored) |
| `error` | HIGH, MEDIUM, **or any ERROR** (SKIPPED still ignored) |

```bash
deprisk scan --latest --fail-on high
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

If neither bundled types nor `@types/*` exist, the package is **SKIPPED** (not ERROR). Use `--include-skipped` to list them in the scan table.

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

## Out of scope / limitations

- Hosted dashboard / SaaS  
- Auto-fix or code-mod suggestions  
- Packages with **neither** bundled types nor `@types/*` → **SKIPPED** (API analysis unavailable)  
- Runtime behavior changes that keep the same TypeScript signature may still be missed  
- PR bump mode supports npm and pnpm lockfiles; Yarn PR / Yarn `--latest` are not supported yet  
- `--latest` supports npm + pnpm  
- Yarn `--latest` scan is not fully supported yet  

## Migrating from 0.8.x to 0.9.0

### Risk model (call-site compatibility)

Risk is no longer “2+ used changed exports = HIGH”.

DepRisk now analyzes **how** you call changed APIs (arity, options keys, overloads, return nullability, property/method use). Compatible call sites stay **LOW** even when the API signature changed.

CI jobs using `--fail-on` may see **fewer** false HIGH/MEDIUM results. Review any workflow that assumed the old count-based model.

### New report fields (additive JSON)

- `compatibility`, `confidence`, `findings[]`
- `compatibleChangeCount`
- Enriched `flagged[].compatibility` / `confidence` / `findings`

### New flag

```bash
deprisk check <pkg> --from A --to B --deep
deprisk scan --latest --deep
```

## Migrating from 0.7.x to 0.8.0

### UP_TO_DATE output

Packages already on npm latest are **summarized by count** in scan output, not listed row-by-row.

To list them:

```bash
deprisk scan --latest --show-up-to-date
# or
deprisk scan --latest --verbose
```

### ERROR vs SKIPPED

Packages with **no usable TypeScript types** (no bundled `.d.ts` and no `@types/*`) are now **`SKIPPED`**, not `ERROR`.

- `SKIPPED` means API analysis is unavailable — **not** a dependency risk finding.
- `SKIPPED` does **not** fail `--fail-on high|medium|error`.
- `ERROR` is reserved for network/fetch/parser failures.

List skipped packages with `--include-skipped`.

### New in 0.8.0

- `.depriskrc.json` / `.depriskrc` project config (CLI overrides file)
- `scan --latest` for **pnpm-lock.yaml** (as well as npm)
- Multi-lockfile detection (prefers pnpm, warns when multiple exist)
- `--sarif <file>` SARIF 2.1.0 export (structurally validated)
- `--show-up-to-date` / `--include-skipped`
- PR bump mode supports **npm and pnpm** lockfiles (Yarn PR/`--latest` still unsupported)

### JSON output

Additive fields only: `skipped`, `lockfileKind`. Existing `reports`, `worstLevel`, and `errors` remain.

### Limitations (unchanged honesty)

- Yarn `--latest` and Yarn PR mode are **not** supported (clear error)
- pnpm parsing covers common `packages:` key styles (lockfileVersion 5.x–10.x); exotic layouts may need follow-up
- Runtime-only behavior changes with identical TypeScript signatures can still be missed
- SARIF is validated structurally for DepRisk’s emitted shape; upload to GitHub Code Scanning should be verified in your CI

## 0.9.0

- **Phase 2:** call-site compatibility analysis (arity, options, overloads, return nullability, properties/methods)
- Compatibility + confidence separate from risk; UNKNOWN never auto-HIGH
- `--deep` for detailed reasoning; analysis always on
- Evidence-based risk scoring (fewer false positives on compatible usage)

## 0.8.0

- **SKIPPED** vs **ERROR** — untyped/native packages no longer flood ERROR / fail CI by default  
- Quieter scan output — Summary counts; UP_TO_DATE hidden unless `--show-up-to-date`  
- **pnpm** support for `scan --latest` + multi-lockfile detection (prefers pnpm, warns)  
- **`.depriskrc.json`** project config (CLI overrides file)  
- **`--sarif <file>`** SARIF 2.1.0 export  
- Clearer Markdown PR reports  

## 0.7.1

- `--fail-on error` — gate on analysis ERRORS; `high`/`medium` ignore them  
- `--fail-on` values validated (`high|medium|error`)

## 0.7.0

- `deprisk scan --latest` / `deprisk check <pkg> --latest` / PR bump scan

## License

MIT
