# Architecture

Toolchain Regression Dashboard has two independent phases:

1. CI or a local operator collects test data from checked-out submodules.
2. A static frontend reads JSONL files and renders current-vs-previous status.

```text
resources/submodules.yaml
  -> main.ts stat
  -> data/toolchain/current/<os>/data.jsonl
  -> data/toolchain/current/<os>/logs/*.log
  -> static frontend
```

There is no server-side API. The JSONL files and logs are the public data surface.

## Modules

| Path                                         | Responsibility                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `main.ts`                                    | CLI entry point for `stat` and `schema`.                                       |
| `lib/toolchain_types.ts`                     | Zod schemas and TypeScript types for config, tasks, metadata, and records.     |
| `lib/submodule_config.ts`                    | YAML loading, path normalization, matrix expansion, and command templates.     |
| `lib/toolchain_stat.ts`                      | Submodule commit detection, command execution, timeout handling, result logs.  |
| `lib/dashboard_data.ts`                      | Current/previous merge, row filtering, sorting, and regression classification. |
| `web.ts`                                     | Preact UI compiled to `web.js`.                                                |
| `scripts/restore_previous.ts`                | Publish helper that restores previous data from the published Pages site.      |
| `.github/workflows/toolchain-regression.yml` | Scheduled collection and GitHub Pages publish.                                 |

## Collection Model

The collector expands `resources/submodules.yaml` into tasks by:

1. Starting with `defaults.matrix` and `defaults.test`.
2. Applying submodule-level matrix and test overrides.
3. Expanding module entries when `modules` is present.
4. Applying module-level matrix and test overrides.
5. Applying matching ordered overrides.
6. Emitting one test record for each `submodule_path + module_path + os + backend`.

Matrix entries matched by `exclude` emit `Excluded` records and do not execute a command.

Executable tasks are grouped by `submodule_path` so one commit lookup covers all modules and backends for that
submodule. A submodule with `resource_intensive: true` is scheduled as an exclusive group: the collector waits for any
running groups to finish before starting it.

## Regression Model

The frontend compares records by `submodule_path + module_path + os + backend`.

A regression is reported when the previous status is `Pass` and the current status is `Error` or `Missing`. `Excluded`
is not a regression. A newly added failing test is a failure, but not a regression because no previous `Pass` exists for
that key.

During publish, the previous baseline advances row by row using `submodule_path + module_path`. Rows with regressions
keep their last published previous data so unresolved regressions remain visible across runs. Rows without regressions
advance to the last published current data.

## JSONL Shape

Each `data/toolchain/<period>/<os>/data.jsonl` file contains:

- line 1: `ToolchainMetadata`
- line 2 onward: `ToolchainResultRecord`

Result records include `env` only when configuration adds environment variables. `stdout_path` and `stderr_path` point
to static log files next to the JSONL output.
