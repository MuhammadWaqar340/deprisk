# DepRisk

CLI that tells you whether an npm dependency update is actually risky — not by reading changelogs, but by checking whether the specific exports your project calls were changed, deprecated, or removed.

Dependabot/Renovate say "this package went from v4 → v5." DepRisk answers: "did the parts *you* use change?"

## Install

```bash
# one-shot
npx deprisk check <package> --from <old> --to <new>

# or install globally (package name is deprisk-check; `deprisk` was already taken on npm)
pnpm add -g deprisk-check
```

Requires Node.js 18+. The binary name remains `deprisk`.

## Usage

```bash
deprisk check lodash --from 4.17.21 --to 5.0.0
deprisk check chalk --from 4.1.2 --to 5.3.0 --path ./my-app
deprisk check ms --from 2.1.2 --to 2.1.3 --verbose
deprisk check zod --from 3.22.0 --to 3.23.0 --json
```

### Options

| Flag | Description |
|------|-------------|
| `--from <version>` | Old package version (required) |
| `--to <version>` | New package version (required) |
| `--path <dir>` | Project to scan (default: cwd) |
| `--verbose` | Print full old/new signatures for flagged exports |
| `--json` | Emit a machine-readable `RiskReport` (for CI / future GitHub Action) |

### Risk levels

- **HIGH** — a used export was removed, or 2+ used exports changed
- **MEDIUM** — exactly one used export changed
- **LOW** — nothing you use was touched (or the package isn't directly imported)

## Example (from this repo)

```bash
pnpm exec tsx src/cli.ts check clsx --from 1.2.1 --to 2.1.1 --path ./demo-project
pnpm exec tsx src/cli.ts check zod --from 3.22.4 --to 3.23.8 --path ./demo-project
pnpm exec tsx src/cli.ts check chalk --from 4.1.2 --to 5.3.0 --path ./demo-project
```

## How it works

1. **Fetcher** — downloads both versions from the npm registry (cached under `~/.deprisk/cache/`)
2. **API Diff** — loads each version's `.d.ts` with ts-morph and diffs the public export surface
3. **Usage Scanner** — finds direct imports/requires of that package in your project and records call sites
4. **Risk Scorer** — intersects the diff with your usages and scores the result

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
pnpm exec tsx src/cli.ts check ms --from 2.1.2 --to 2.1.3
```

## Explicitly out of scope (v1)

These are intentional non-goals for this release — see "future work" if you'd like to contribute them later:

- JavaScript-only packages with no `.d.ts` files
- Monorepo / workspace awareness
- Tracing re-exports through the consumer's own barrel files
- GitHub Action / PR-comment integration
- Hosted dashboard or SaaS
- Auto-fix or code-mod suggestions

## License

MIT
