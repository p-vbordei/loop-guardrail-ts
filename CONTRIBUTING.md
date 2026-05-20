# Contributing

Thanks for considering a contribution.

## Quick start

```sh
git clone https://github.com/p-vbordei/loop-guardrail-ts.git
cd loop-guardrail-ts
npm install
npm test
```

## Workflow

1. Open an issue first for non-trivial changes — happy to discuss approach before you sink time.
2. Fork, branch from `main`, make changes.
3. Run `npm run typecheck && npm run build && npm test` locally before pushing.
4. Open a PR with a clear description of the change.

## Code style

- TypeScript, strict mode.
- Tests live in `test/` next to source in `src/`.
- Prefer small focused PRs over big ones.
- Match existing naming and structure.

## Test requirements

- All public API surface must be tested.
- Tests should be deterministic — inject clocks/random/IO instead of relying on real ones.

## Release

Maintainer rolls releases. Bump version in `package.json`, update `CHANGELOG.md`, tag, publish. Don't open PRs that only bump versions.

## License

By contributing you agree your contribution will be licensed under the project's existing license (Apache-2.0).
