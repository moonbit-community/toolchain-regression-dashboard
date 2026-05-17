# Toolchain Regression Dashboard

[![Dashboard status](https://moonbit-community.github.io/toolchain-regression-dashboard/data/toolchain/status.svg)](https://moonbit-community.github.io/toolchain-regression-dashboard/)

Toolchain Regression Dashboard tracks MoonBit `moon test` results for submodules that are already checked out in this
workspace. CI publishes the latest run under `data/toolchain/current/<os>` and restores the previously published run
under `data/toolchain/previous/<os>` so the static frontend can mark regressions. Previous baselines are preserved per
`submodule_path + module_path` while published regressions are still present.

## Documentation

- [Architecture](docs/architecture.md) explains the data flow, modules, and runtime boundaries.
- [Configuration](docs/configuration.md) documents `resources/submodules.yaml`, matrix expansion, overrides, and command
  templates.
- [Operations](docs/operations.md) covers local development, CI, generated artifacts, and troubleshooting.

## Configuration

`resources/submodules.yaml` is the CI source of truth. Its top-level `submodules` keys are workspace-relative paths such
as `deps/parser`. The collector does not clone or update those paths; checkout and submodule initialization are handled
outside the dashboard.

Validate and refresh the JSON schema after changing config types:

```sh
deno task schema
```

## Collect Data

Run the collector for the current host OS or an explicit OS id:

```sh
deno run -A main.ts stat --config resources/submodules.yaml --os linux-x64
```

Output is written to `data/toolchain/current/<os>/data.jsonl`; logs are written under
`data/toolchain/current/<os>/logs/`.

## Dashboard

Build the static frontend:

```sh
deno task bundle
```

Generate the README status badge from current data:

```sh
deno task status-badge
```

The published badge is written to `data/toolchain/status.svg`. It is green when every current dashboard cell is `Pass`
or `Excluded`, and red when any current cell is `Error` or `Missing`.

Then serve the directory with any static file server and open `index.html`.

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

## Data API

The frontend reads:

```text
data/toolchain/current/linux-x64/data.jsonl
data/toolchain/current/macos-arm64/data.jsonl
data/toolchain/current/windows-x64/data.jsonl
data/toolchain/previous/linux-x64/data.jsonl
data/toolchain/previous/macos-arm64/data.jsonl
data/toolchain/previous/windows-x64/data.jsonl
data/toolchain/status.svg
```

Each file is newline-delimited JSON. The first line is metadata with `generated_at`, `runId`, `runNumber`, and
`toolchainVersion`; every following line is one `submodule_path + module_path + os + backend` test result.

## Development

```sh
deno task fmt
deno task lint
deno task check
deno task test
deno task schema
deno task status-badge
deno task bundle
```
