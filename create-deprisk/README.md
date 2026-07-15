# create-deprisk

Scaffold a [DepRisk](https://www.npmjs.com/package/deprisk-check) GitHub Actions workflow in any project.

## Usage

```bash
cd your-project
npx create-deprisk
```

Creates `.github/workflows/deprisk.yml`.

### Options

```bash
npx create-deprisk --force
npx create-deprisk --fail-on medium
npx create-deprisk --path ./apps/web
```

## Related

- CLI: [`deprisk-check`](https://www.npmjs.com/package/deprisk-check) — `npx -p deprisk-check deprisk init` does the same thing
- Binary: `deprisk init`

## License

MIT
