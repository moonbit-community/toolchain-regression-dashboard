import {
  buildRows,
  cellKey,
  type CellStatus,
  DASHBOARD_BACKENDS,
  DASHBOARD_OSES,
  type DashboardData,
  emptyDataMap,
} from './dashboard_data.ts';

const PASS_COLOR = '#2ea44f';
const FAIL_COLOR = '#d73a49';
const LABEL_COLOR = '#555555';

export type DashboardOverallStatus = 'passing' | 'failing';

export interface DashboardStatusSummary {
  status: DashboardOverallStatus;
  ok: boolean;
  label: string;
  message: string;
  color: string;
  rowCount: number;
  totalCount: number;
  passCount: number;
  errorCount: number;
  excludedCount: number;
  missingCount: number;
}

export function summarizeDashboardStatus(data: DashboardData): DashboardStatusSummary {
  const rows = buildRows({ current: data.current, previous: emptyDataMap() });
  const counts: Record<CellStatus, number> = {
    pass: 0,
    error: 0,
    excluded: 0,
    missing: 0,
  };

  for (const row of rows) {
    for (const os of DASHBOARD_OSES) {
      for (const backend of DASHBOARD_BACKENDS) {
        const status = row.cells.get(cellKey(os, backend))?.status ?? 'missing';
        counts[status] += 1;
      }
    }
  }

  const ok = rows.length > 0 && counts.error === 0 && counts.missing === 0;
  return {
    status: ok ? 'passing' : 'failing',
    ok,
    label: 'dashboard',
    message: ok ? 'passing' : 'failing',
    color: ok ? PASS_COLOR : FAIL_COLOR,
    rowCount: rows.length,
    totalCount: counts.pass + counts.error + counts.excluded + counts.missing,
    passCount: counts.pass,
    errorCount: counts.error,
    excludedCount: counts.excluded,
    missingCount: counts.missing,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function badgeTextWidth(value: string): number {
  return Math.max(44, Math.ceil(value.length * 6.8 + 10));
}

export function renderDashboardStatusSvg(summary: DashboardStatusSummary): string {
  const labelWidth = badgeTextWidth(summary.label);
  const messageWidth = badgeTextWidth(summary.message);
  const width = labelWidth + messageWidth;
  const title = `${summary.label}: ${summary.message}`;
  const detail =
    `${summary.passCount} pass, ${summary.errorCount} error, ${summary.missingCount} missing, ${summary.excludedCount} excluded`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${
    escapeXml(title)
  }">
  <title>${escapeXml(`${title} (${detail})`)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#ffffff" stop-opacity=".12"/>
    <stop offset="1" stop-opacity=".12"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${width}" height="20" rx="3" fill="#ffffff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="${LABEL_COLOR}"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${summary.color}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#ffffff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(summary.label)}</text>
    <text x="${labelWidth / 2}" y="14">${escapeXml(summary.label)}</text>
    <text x="${labelWidth + messageWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${
    escapeXml(summary.message)
  }</text>
    <text x="${labelWidth + messageWidth / 2}" y="14">${escapeXml(summary.message)}</text>
  </g>
</svg>
`;
}
