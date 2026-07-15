# Benchmark corpus (Phase 5)

Known packages used to smoke-test DepRisk manually / in CI docs.

| Package | From → To | Expect | Notes |
|---------|-----------|--------|-------|
| vite | 8.0.0 → 8.1.0 | LOW (typical app usage) | Bundled types |
| clsx | 1.2.1 → 2.1.1 | varies | Default-export normalization |
| zod | 3.22.4 → 3.23.8 | LOW for `z` only | Bundled types |
| lodash | 4.17.20 → 4.17.21 | LOW / notImported | DefinitelyTyped `@types/lodash` |
| @vitejs/plugin-react | 5.0.0 → 6.0.3 | LOW if only `default` used | Bundled types |

```bash
pnpm exec tsx src/cli.ts check lodash --from 4.17.20 --to 4.17.21 --path ../renovate-demo
pnpm exec tsx src/cli.ts check vite --from 8.0.0 --to 8.1.0 --path ../renovate-demo --fail-on high
```
