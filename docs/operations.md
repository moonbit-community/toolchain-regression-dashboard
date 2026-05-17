# Operations

This guide covers day-to-day operation of Toolchain Regression Dashboard.

## Local Checks

```sh
deno task fmt
deno task lint
deno task check
deno task test
deno task schema
deno task status-badge
deno task bundle
```

## Local Collection

Run collection for one OS:

```sh
deno run -A main.ts stat \
  --config resources/submodules.yaml \
  --os linux-x64 \
  --out-dir data/toolchain/current/linux-x64
```

Generated files:

- `data/toolchain/current/<os>/data.jsonl`
- `data/toolchain/current/<os>/logs/*.stdout.log`
- `data/toolchain/current/<os>/logs/*.stderr.log`

The collector does not initialize or update submodules. Ensure the configured paths already exist and have commits.

## CI

`.github/workflows/toolchain-regression.yml` runs on a schedule and manually via `workflow_dispatch`.

The collect job:

1. Checks out the repository with `submodules: recursive`.
2. Installs the nightly MoonBit toolchain.
3. Runs `main.ts stat` for one OS.
4. Uploads `data/toolchain/current/<os>` as an artifact.

The publish job:

1. Downloads current artifacts.
2. Restores `data/toolchain/previous` from the published site. It advances rows without regressions to the published
   `current`, while rows with regressions keep the published `previous` baseline. Rows are keyed by
   `submodule_path + module_path`.
3. Generates `data/toolchain/status.svg` for the README status badge.
4. Bundles `web.ts`.
5. Publishes `index.html`, `web.js`, and `data/` to GitHub Pages.

Set the repository variable `PAGES_BASE_URL` if the default Pages URL is not correct for the repository.

## Statuses

- `Pass`: the test command exited successfully.
- `Error`: commit lookup failed or the test command failed.
- `Excluded`: the matrix entry matched an `exclude` rule.
- `Missing`: rendered only in the frontend when one period has no record for a key.

A regression is previous `Pass` to current `Error` or `Missing`. The README badge is green when every current dashboard
cell is `Pass` or `Excluded`, and red when any current cell is `Error` or `Missing`.

## Troubleshooting

If a submodule path is missing or is not a Git checkout, the record is `Error` and stderr contains the commit lookup
failure.

If a configured working directory is wrong, the test command record is `Error` and the log contains the process spawn
failure.

If previous data is empty, the publish job could not fetch the currently published Pages data. Check `PAGES_BASE_URL`
and the Pages deployment URL.

If the dashboard is blank locally, verify that `web.js` exists and that both current and previous JSONL paths are
reachable from the static file server.
