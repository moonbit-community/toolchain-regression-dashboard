import type {
  ToolchainBackend,
  ToolchainMetadata,
  ToolchainOS,
  ToolchainResultRecord,
  ToolchainStatus,
} from './toolchain_types.ts';

export const DASHBOARD_OSES = ['linux-x64', 'macos-arm64', 'windows-x64'] as const satisfies readonly ToolchainOS[];
export const DASHBOARD_BACKENDS = ['wasm', 'wasm-gc', 'js', 'native'] as const satisfies readonly ToolchainBackend[];

export type Filter = 'all' | 'error' | 'excluded' | 'pass' | 'regression';
export type CellStatus = 'pass' | 'error' | 'excluded' | 'missing';

export type DataMap = Record<ToolchainOS, {
  metadata: ToolchainMetadata | null;
  results: ToolchainResultRecord[];
}>;

export type DashboardData = {
  current: DataMap;
  previous: DataMap;
};

export type CellData = {
  current?: ToolchainResultRecord;
  previous?: ToolchainResultRecord;
  status: CellStatus;
  previousStatus: CellStatus;
  regression: boolean;
};

export type RowData = {
  key: string;
  submodule_path: string;
  module_path: string;
  commit_sha?: string;
  previous_commit_sha?: string;
  cells: Map<string, CellData>;
  status: CellStatus;
  passCount: number;
  errorCount: number;
  excludedCount: number;
  missingCount: number;
  regressionCount: number;
};

export const STATUS_PRIORITY: Record<CellStatus, number> = {
  error: 0,
  missing: 1,
  pass: 2,
  excluded: 3,
};

export function emptyDataMap(): DataMap {
  return {
    'linux-x64': { metadata: null, results: [] },
    'macos-arm64': { metadata: null, results: [] },
    'windows-x64': { metadata: null, results: [] },
  };
}

export function emptyDashboardData(): DashboardData {
  return {
    current: emptyDataMap(),
    previous: emptyDataMap(),
  };
}

export function cellKey(os: ToolchainOS, backend: ToolchainBackend): string {
  return `${os}/${backend}`;
}

export function rowKey(record: Pick<ToolchainResultRecord, 'submodule_path' | 'module_path'>): string {
  return `${record.submodule_path}\0${record.module_path}`;
}

export function toCellStatus(status: ToolchainStatus | undefined): CellStatus {
  if (status === 'Pass') return 'pass';
  if (status === 'Error') return 'error';
  if (status === 'Excluded') return 'excluded';
  return 'missing';
}

export function isRegression(previousStatus: CellStatus, currentStatus: CellStatus): boolean {
  return previousStatus === 'pass' && (currentStatus === 'error' || currentStatus === 'missing');
}

function computeRowStatus(row: RowData): CellStatus {
  if (row.errorCount > 0) return 'error';
  if (row.missingCount > 0) return 'missing';
  if (row.passCount > 0) return 'pass';
  return row.excludedCount > 0 ? 'excluded' : 'missing';
}

function ensureRow(rows: Map<string, RowData>, record: ToolchainResultRecord): RowData {
  const key = rowKey(record);
  const existing = rows.get(key);
  if (existing) return existing;

  const row: RowData = {
    key,
    submodule_path: record.submodule_path,
    module_path: record.module_path,
    commit_sha: undefined,
    previous_commit_sha: undefined,
    cells: new Map<string, CellData>(),
    status: 'missing',
    passCount: 0,
    errorCount: 0,
    excludedCount: 0,
    missingCount: 0,
    regressionCount: 0,
  };
  rows.set(key, row);
  return row;
}

export function buildRows(data: DashboardData): RowData[] {
  const rows = new Map<string, RowData>();

  for (const os of DASHBOARD_OSES) {
    for (const record of data.current[os].results) {
      const row = ensureRow(rows, record);
      const key = cellKey(record.os, record.backend);
      const cell = row.cells.get(key) ?? { status: 'missing', previousStatus: 'missing', regression: false };
      cell.current = record;
      row.cells.set(key, cell);
      row.commit_sha = row.commit_sha ?? record.commit_sha;
    }

    for (const record of data.previous[os].results) {
      const row = ensureRow(rows, record);
      const key = cellKey(record.os, record.backend);
      const cell = row.cells.get(key) ?? { status: 'missing', previousStatus: 'missing', regression: false };
      cell.previous = record;
      row.cells.set(key, cell);
      row.previous_commit_sha = row.previous_commit_sha ?? record.commit_sha;
    }
  }

  const result = Array.from(rows.values());
  for (const row of result) {
    let passCount = 0;
    let errorCount = 0;
    let excludedCount = 0;
    let missingCount = 0;
    let regressionCount = 0;

    for (const os of DASHBOARD_OSES) {
      for (const backend of DASHBOARD_BACKENDS) {
        const key = cellKey(os, backend);
        const cell = row.cells.get(key) ?? {
          status: 'missing',
          previousStatus: 'missing',
          regression: false,
        };
        cell.status = toCellStatus(cell.current?.status);
        cell.previousStatus = toCellStatus(cell.previous?.status);
        cell.regression = isRegression(cell.previousStatus, cell.status);
        row.cells.set(key, cell);

        if (cell.status === 'pass') passCount += 1;
        if (cell.status === 'error') errorCount += 1;
        if (cell.status === 'excluded') excludedCount += 1;
        if (cell.status === 'missing') missingCount += 1;
        if (cell.regression) regressionCount += 1;
      }
    }

    row.passCount = passCount;
    row.errorCount = errorCount;
    row.excludedCount = excludedCount;
    row.missingCount = missingCount;
    row.regressionCount = regressionCount;
    row.status = computeRowStatus(row);
  }

  result.sort((a, b) => {
    if (a.regressionCount !== b.regressionCount) return b.regressionCount - a.regressionCount;
    const priority = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (priority !== 0) return priority;
    return a.submodule_path.localeCompare(b.submodule_path) || a.module_path.localeCompare(b.module_path);
  });
  return result;
}

export function filterRows(rows: RowData[], filter: Filter, search: string): RowData[] {
  const keyword = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === 'regression') {
      if (row.regressionCount === 0) return false;
    } else if (filter === 'excluded') {
      if (row.excludedCount === 0) return false;
    } else if (filter !== 'all' && row.status !== filter) {
      return false;
    }

    if (
      keyword &&
      !`${row.submodule_path} ${row.module_path} ${row.commit_sha ?? ''} ${row.previous_commit_sha ?? ''}`
        .toLowerCase()
        .includes(keyword)
    ) {
      return false;
    }

    return true;
  });
}

export function countRows(rows: RowData[]): Record<Filter, number> {
  return {
    all: rows.length,
    error: rows.filter((row) => row.status === 'error').length,
    excluded: rows.filter((row) => row.excludedCount > 0).length,
    pass: rows.filter((row) => row.status === 'pass').length,
    regression: rows.filter((row) => row.regressionCount > 0).length,
  };
}

export function regressionRowKeys(data: DashboardData): Set<string> {
  return new Set(buildRows(data).filter((row) => row.regressionCount > 0).map((row) => row.key));
}

export function hasRegression(data: DashboardData): boolean {
  return regressionRowKeys(data).size > 0;
}
