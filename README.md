# DepRisk

CLI that tells you whether an npm dependency update is actually risky — not by reading changelogs, but by checking whether the specific exports your project calls were changed, deprecated, or removed.

Dependabot/Renovate say "this package went from v4 → v5." DepRisk answers: "did the parts *you* use change?"

## Install

```bash
npm install -D deprisk-check
# or one-shot:
npx --package=deprisk-check deprisk check <package> --from <old> --to <new>
```

Requires Node.js 18+. Package name: **`deprisk-check`**. Binary: **`deprisk`**.

## Usage

```bash
deprisk check lodash --from 4.17.20 --to 4.17.21
deprisk check vite --from 8.0.0 --to 8.1.0 --path ./my-app
deprisk check chalk --from 4.1.2 --to 5.3.0 --verbose
deprisk check zod --from 3.22.0 --to 3.23.0 --json
deprisk check vite --from 8.0.0 --to 8.1.0 --fail-on high
deprisk check lodash --from 4.17.20 --to 4.17.21 --follow-reexports --workspaces
```

### Options

| Flag | Description |
|------|-------------|
| `--from <version>` | Old version (optional if lockfile autodetection can resolve it) |
| `--to <version>` | New version |
| `--path <dir>` | Project to scan (default: cwd) |
| `--verbose` | Print full old/new signatures for flagged exports |
| `--json` | Emit machine-readable `RiskReport` |
| `--markdown` | Emit Markdown (PR comments) |
| `--html <file>` | Write an HTML report |
| `--fail-on high\|medium` | Exit non-zero when risk meets the threshold |
| `--follow-reexports` | Trace consumer barrel files |
| `--workspaces` | Also scan monorepo workspace packages |
| `--semver-weight` | Weight major-version bumps more heavily |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | LOW (or below `--fail-on` threshold) |
| `1` | MEDIUM (default) or runtime error |
| `2` | HIGH |

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

Create a workflow in any project:

```bash
# from your app repo (e.g. renovate-demo)
npx --package=deprisk-check deprisk init
# or after installing:
deprisk init
deprisk init --force --fail-on medium
```

This writes `.github/workflows/deprisk.yml`. Commit and push it — DepRisk will run on dependency PRs.

See also [`action.yml`](./action.yml) and [`.github/workflows/deprisk-pr.yml`](./.github/workflows/deprisk-pr.yml).

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

## License

MIT
