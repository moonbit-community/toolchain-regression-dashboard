import {
  buildRows,
  countRows,
  emptyDashboardData,
  filterRows,
  hasRegression,
  isRegression,
  regressionRowKeys,
} from './dashboard_data.ts';
import { ToolchainResultRecord } from './toolchain_types.ts';

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Assertion failed:\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

function record(
  submodule_path: string,
  module_path: string,
  status: ToolchainResultRecord['status'],
  backend: ToolchainResultRecord['backend'] = 'wasm',
): ToolchainResultRecord {
  return {
    submodule_path,
    module_path,
    commit_sha: status === 'Pass' ? 'a'.repeat(40) : 'b'.repeat(40),
    os: 'linux-x64',
    backend,
    status,
    working_directory: module_path,
  };
}

Deno.test('isRegression only counts Pass to Error or Missing', () => {
  assertEquals(isRegression('pass', 'error'), true);
  assertEquals(isRegression('pass', 'missing'), true);
  assertEquals(isRegression('error', 'error'), false);
  assertEquals(isRegression('error', 'pass'), false);
  assertEquals(isRegression('missing', 'error'), false);
  assertEquals(isRegression('pass', 'excluded'), false);
});

Deno.test('buildRows merges current and previous JSONL results and counts regressions', () => {
  const data = emptyDashboardData();
  data.previous['linux-x64'].results = [
    record('deps/parser', '.', 'Pass'),
    record('deps/parser', 'examples', 'Pass'),
    record('deps/new-failure', '.', 'Error'),
    record('deps/excluded', '.', 'Pass'),
  ];
  data.current['linux-x64'].results = [
    record('deps/parser', '.', 'Error'),
    record('deps/new-failure', '.', 'Error'),
    record('deps/excluded', '.', 'Excluded'),
  ];

  const rows = buildRows(data);
  const parser = rows.find((row) => row.submodule_path === 'deps/parser' && row.module_path === '.')!;
  const missing = rows.find((row) => row.submodule_path === 'deps/parser' && row.module_path === 'examples')!;
  const newFailure = rows.find((row) => row.submodule_path === 'deps/new-failure')!;
  const excluded = rows.find((row) => row.submodule_path === 'deps/excluded')!;

  assertEquals(parser.regressionCount, 1);
  assertEquals(missing.regressionCount, 1);
  assertEquals(newFailure.regressionCount, 0);
  assertEquals(excluded.regressionCount, 0);
  assertEquals(countRows(rows).regression, 2);
});

Deno.test('filterRows supports search, status filters, sorting, and regression filter', () => {
  const data = emptyDashboardData();
  data.previous['linux-x64'].results = [
    record('deps/parser', '.', 'Pass'),
    record('deps/stable', '.', 'Pass'),
  ];
  data.current['linux-x64'].results = [
    record('deps/parser', '.', 'Error'),
    record('deps/stable', '.', 'Pass'),
  ];
  const rows = buildRows(data);

  assertEquals(rows[0].submodule_path, 'deps/parser');
  assertEquals(filterRows(rows, 'regression', '').map((row) => row.submodule_path), ['deps/parser']);
  assertEquals(filterRows(rows, 'pass', '').map((row) => row.submodule_path), []);
  assertEquals(filterRows(rows, 'all', 'stable').map((row) => row.submodule_path), ['deps/stable']);
});

Deno.test('hasRegression detects whether the published baseline should be preserved', () => {
  const regressed = emptyDashboardData();
  regressed.previous['linux-x64'].results = [record('deps/parser', '.', 'Pass')];
  regressed.current['linux-x64'].results = [record('deps/parser', '.', 'Error')];

  const alreadyFailing = emptyDashboardData();
  alreadyFailing.previous['linux-x64'].results = [record('deps/parser', '.', 'Error')];
  alreadyFailing.current['linux-x64'].results = [record('deps/parser', '.', 'Error')];

  assertEquals(hasRegression(regressed), true);
  assertEquals(hasRegression(alreadyFailing), false);
  assertEquals(Array.from(regressionRowKeys(regressed)), ['deps/parser\0.']);
  assertEquals(Array.from(regressionRowKeys(alreadyFailing)), []);
});
