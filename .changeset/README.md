# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). Each Markdown
file in here describes one pending, user-visible change to the publishable packages and the semver
bump it deserves.

## Adding a changeset

```bash
pnpm changeset
```

Pick the affected package(s), the bump type (`patch` / `minor` / `major`), and write a short
changelog entry aimed at users of the package - it ends up verbatim in `CHANGELOG.md`. Commit the
generated file with your PR.

When to add one:

- any change to `@luxalgo/prop-firm-sim-core`, `-cli`, or `-mcp` that users can observe
  (behavior, API, output, dataset contents bundled into core)
- not needed for CI, docs, or test-only changes

## How releases happen

On every push to `main`, `.github/workflows/release.yml` collects pending changesets into a
"Version Packages" PR (version bumps + changelogs). Merging that PR publishes the bumped packages
to npm (when the `NPM_TOKEN` secret is configured) and creates the git tags.
