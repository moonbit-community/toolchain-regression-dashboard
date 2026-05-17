import { DASHBOARD_BACKENDS, DASHBOARD_OSES, emptyDashboardData } from './dashboard_data.ts';
import { renderDashboardStatusSvg, summarizeDashboardStatus } from './dashboard_status.ts';
import type { ToolchainBackend, ToolchainOS, ToolchainResultRecord } from './toolchain_types.ts';

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Assertion failed:\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

function assertIncludes(actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`Assertion failed: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

function record(
  os: ToolchainOS,
  backend: ToolchainBackend,
  status: ToolchainResultRecord['status'],
): ToolchainResultRecord {
  return {
    submodule_path: 'deps/parser',
    module_path: '.',
    commit_sha: 'a'.repeat(40),
    os,
    backend,
    status,
    working_directory: '.',
  };
}

function fillMatrix(status: ToolchainResultRecord['status']): ReturnType<typeof emptyDashboardData> {
  const data = emptyDashboardData();
  for (const os of DASHBOARD_OSES) {
    data.current[os].results = DASHBOARD_BACKENDS.map((backend) => record(os, backend, status));
  }
  return data;
}

Deno.test('summarizeDashboardStatus is passing when every current cell is Pass', () => {
  const summary = summarizeDashboardStatus(fillMatrix('Pass'));

  assertEquals(summary.ok, true);
  assertEquals(summary.status, 'passing');
  assertEquals(summary.passCount, DASHBOARD_OSES.length * DASHBOARD_BACKENDS.length);
  assertEquals(summary.errorCount, 0);
  assertEquals(summary.missingCount, 0);
});

Deno.test('summarizeDashboardStatus treats Excluded as non-failing current cells', () => {
  const data = fillMatrix('Pass');
  data.current['linux-x64'].results[0] = record('linux-x64', 'wasm', 'Excluded');
  const summary = summarizeDashboardStatus(data);

  assertEquals(summary.ok, true);
  assertEquals(summary.excludedCount, 1);
});

Deno.test('summarizeDashboardStatus is failing when any current cell is Error', () => {
  const data = fillMatrix('Pass');
  data.current['macos-arm64'].results[0] = record('macos-arm64', 'wasm', 'Error');
  const summary = summarizeDashboardStatus(data);

  assertEquals(summary.ok, false);
  assertEquals(summary.status, 'failing');
  assertEquals(summary.errorCount, 1);
});

Deno.test('summarizeDashboardStatus is failing when a current cell is missing', () => {
  const data = fillMatrix('Pass');
  data.current['windows-x64'].results = data.current['windows-x64'].results.filter((item) => item.backend !== 'native');
  const summary = summarizeDashboardStatus(data);

  assertEquals(summary.ok, false);
  assertEquals(summary.missingCount, 1);
});

Deno.test('renderDashboardStatusSvg uses green or red status colors', () => {
  assertIncludes(renderDashboardStatusSvg(summarizeDashboardStatus(fillMatrix('Pass'))), '#2ea44f');
  assertIncludes(renderDashboardStatusSvg(summarizeDashboardStatus(emptyDashboardData())), '#d73a49');
});
