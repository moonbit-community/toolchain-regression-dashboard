# Configuration

`resources/submodules.yaml` is the source of truth for collection.

```yaml
# yaml-language-server: $schema=submodules.schema.json
schema_version: 1

defaults:
  matrix:
    os: [linux-x64, macos-arm64, windows-x64]
    backends: [wasm, wasm-gc, js, native]
  test:
    argv: [moon, test, --target, '{backend}']
    timeout_seconds: 1200

submodules:
  deps/parser:
    resource_intensive: true
```

## Submodule Paths

Top-level `submodules` keys are workspace-relative paths. They are normalized before duplicate detection, so
`deps/parser`, `./deps/parser`, and `deps/parser/` refer to the same submodule.

URL, absolute, and parent-traversal paths are rejected. The collector expects these paths to exist in the current
workspace and reads each commit with:

```sh
git -C <submodule_path> rev-parse HEAD
```

## Matrix

`matrix` may be set at defaults, submodule, or module level:

```yaml
matrix:
  os: [linux-x64]
  backends: [wasm, js]
  exclude:
    - os: windows-x64
      backend: native
```

`exclude` entries still create `Excluded` records. They do not count as regressions.

## Test Command

Only `test` is supported. `check`, `branch`, repo URL fields, and `run_after: check_passed` are intentionally rejected.

Exactly one executable form must be effective after merging:

```yaml
test:
  argv: [moon, test, --target, '{backend}']
```

```yaml
test:
  shell: moon test --target '{backend}'
```

Supported command fields:

- `argv`
- `shell`
- `timeout_seconds`
- `env`
- `working_directory`

## Modules

For multi-module submodules, use `modules`:

```yaml
submodules:
  deps/parser:
    modules:
      - path: .
      - path: examples/json
        matrix:
          backends: [wasm]
```

If `modules` is absent, the collector emits one module with path `.` or the submodule-level `working_directory`.

## Overrides

Overrides apply after defaults, submodule config, and module config. Multiple matching overrides apply in file order.

```yaml
submodules:
  deps/parser:
    overrides:
      - match:
          os: [linux-x64]
          backends: [native]
        env:
          NATIVE_ONLY: '1'
        test:
          shell: ./scripts/native-test.sh {backend}
          timeout_seconds: 1800
```

Override `env` values are merged into the effective command environment. A `test.env` on the command can still override
the same key.

## Templates

Template variables are expanded in `argv` and `shell`:

- `{backend}`
- `{os}`
- `{submodule}`
- `{module}`
- `{working_directory}`

## Schema

Regenerate the schema after changing `lib/toolchain_types.ts`:

```sh
deno task schema
```

The generated file is `resources/submodules.schema.json`.
