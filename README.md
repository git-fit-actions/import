# git-fit-actions/import

GitHub Action for importing static fitness data sources into [git-fit](https://github.com/Lax/git-fit).
Detects changes via directory tree hash, downloads files from a git branch
(`git show | git lfs smudge`), runs `git fit import <cmd>`, and caches import
state markers for skip detection.

## Data Sources

This action drives `git fit import`. Supported sources:

| Source | What is imported |
|---|---|
| `apple_health` | Apple Health `export.zip` (XML + GPX) |
| `2bulu` | 2bulu `.2tk` + `.kml` files |
| `gpx` | Local GPX files |
| `fit` | Local FIT files |
| `tcx` | Local TCX files |

Data file format details, parsing rules, and per-source requirements live in
the [git-fit project](https://github.com/Lax/git-fit) (`git fit import --help`,
README "Import" section). This repo only covers the action itself.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|---|
| `sources` | yes | — | Comma- or newline-separated list of sources (see table above) |
| `db-path` | no | `data/db/workouts.db` | SQLite database path |
| `store-state` | no | `true` | Push SHA256SUMS back to the import branch after a successful import. Requires git push auth; failure is non-blocking |
| `branch` | no | `GitFit/import/{source}` | Branch override, supports the `{source}` placeholder (see below) |
| `cache-key` | no | `import-{source}-v0-marker` | Cache key prefix override, supports the `{source}` placeholder |

## Outputs

| Output | Description |
|---|---|
| `changed` | Whether any source was imported |
| `imported_sources` | Comma-joined list of sources that were imported |
| `skipped_sources` | Comma-joined list of sources that were skipped |
| `imported_<source>` | `true`/`false` per source |
| `data_hash_<source>` | Per-source data hash (blanks when skipped/failed) |
| `skip_reason_<source>` | Per-source skip reason |

## Usage

```yaml
steps:
  - uses: git-fit-actions/import@v1
    with:
      sources: apple_health,2bulu
      db-path: data/db/workouts.db
```

Imports from the branch named after each source (e.g. `GitFit/import/apple_health`)
on the `origin` remote of the checkout.

### `{source}` placeholder

`branch` and `cache-key` accept a `{source}` placeholder, expanded per source.
A literal value (no placeholder) applies to every source.

```yaml
- uses: git-fit-actions/import@v1
  with:
    sources: gpx,fit,tcx
    branch: GitFit/import/dev-{source}   # → GitFit/import/dev-gpx, .../dev-fit, ...
```

Pointing every source at one branch (monorepo layout) requires that branch to
contain the per-source `data/import/<source>` subdirectories:

```yaml
- uses: git-fit-actions/import@v1
  with:
    sources: gpx,fit
    branch: GitFit/import/all            # holds data/import/gpx/ and data/import/fit/
```

With `store-state: true` on a shared (monorepo) branch, each source pushes its
own SHA256SUMS. The push is non-fast-forward by default — a rejected push is
warned about (non-blocking), never forced.

The local import directory is always `data/import/<source>`, matching git-fit's
hardcoded scan paths (`git fit import gpx/fit/tcx`); it is not overridable.

Requires a Ruby environment with the `git-fit` gem installed (the action shells
out to `bundle exec git fit import`), and `git-lfs` on the runner for LFS-tracked
data.

## Development

```sh
npm ci
npm run typecheck
npm test        # builds dist then runs node --test
npm run build:check   # asserts dist is up to date
```

CI runs on push to `master` and on tag push (`v*`): `check-dist` (dist
freshness), `test` (actionlint + unit tests), and `smoke` (real import against
a throwaway branch, cleaned up afterwards). `smoke` runs against the latest
git-fit release by default; trigger it manually with `workflow_dispatch` and set
`git-fit-version` to a specific constraint (e.g. `~> 0.13.0`) to validate a
pinned version. The step summary always reports the exact git-fit version
tested.

## License

MIT
