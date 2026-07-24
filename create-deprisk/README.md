# create-deprisk

Scaffold a [DepRisk](https://www.npmjs.com/package/deprisk-check) GitHub Actions workflow in any project.

Pins **`deprisk-check@0.8.0`** in the generated workflow.

## Usage

```bash
cd your-project
npx create-deprisk
```

Creates `.github/workflows/deprisk.yml`.

### Options

```bash
npx create-deprisk --force
npx create-deprisk --fail-on high      # default
npx create-deprisk --fail-on medium
npx create-deprisk --fail-on error     # also fail on analysis ERROR (not SKIPPED)
npx create-deprisk --path ./apps/web
npx create-deprisk --output .github/workflows/deprisk.yml
```

## Related

- CLI: [`deprisk-check`](https://www.npmjs.com/package/deprisk-check) — `npx -p deprisk-check deprisk init` does the same thing
- Full command list: see the main repo [`commands.md`](../commands.md)
- Binary: `deprisk init`

## License

MIT
