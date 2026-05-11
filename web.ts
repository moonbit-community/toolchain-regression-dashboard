import { JsonParseStream } from '@std/json/parse-stream';
import { TextLineStream } from '@std/streams/text-line-stream';
import { html, render } from 'npm:htm@3.1.1/preact';
import { useEffect, useMemo, useState } from 'npm:preact@10.27.2/hooks';
import {
  buildRows,
  cellKey,
  CellStatus,
  countRows,
  DASHBOARD_BACKENDS,
  DASHBOARD_OSES,
  DashboardData,
  emptyDashboardData,
  Filter,
  filterRows,
  RowData,
} from './lib/dashboard_data.ts';
import type { ToolchainMetadata, ToolchainResultRecord } from './lib/toolchain_types.ts';

const STATUS_COLORS: Record<CellStatus, string> = {
  pass: '#15803d',
  error: '#dc2626',
  excluded: '#e2e8f0',
  missing: '#94a3b8',
};

const STATUS_TEXT_COLORS: Record<CellStatus, string> = {
  pass: '#ffffff',
  error: '#ffffff',
  excluded: '#334155',
  missing: '#ffffff',
};

const STATUS_LABELS: Record<CellStatus, string> = {
  pass: 'P',
  error: 'E',
  excluded: 'EX',
  missing: '-',
};

async function readJsonl(
  response: Response,
): Promise<{ metadata: ToolchainMetadata | null; results: ToolchainResultRecord[] }> {
  if (!response.ok || !response.body) {
    return { metadata: null, results: [] };
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
    .pipeThrough(new JsonParseStream())
    .getReader();
  const first = await reader.read();
  const metadata = first.done ? null : first.value as unknown as ToolchainMetadata;
  const results: ToolchainResultRecord[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    results.push(value as unknown as ToolchainResultRecord);
  }

  return { metadata, results };
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.length >= 16 ? value.slice(0, 16).replace('T', ' ') : value;
  }

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${
    pad2(date.getMinutes())
  }`;
}

function formatToolchainVersion(version: string[] | undefined): string {
  return version?.join('\n').trim() || '-';
}

function formatEnv(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : '-';
}

function osSummary(row: RowData, os: (typeof DASHBOARD_OSES)[number]): { status: CellStatus; label: string } {
  let pass = 0;
  let error = 0;
  let excluded = 0;
  let missing = 0;
  let regressions = 0;

  for (const backend of DASHBOARD_BACKENDS) {
    const cell = row.cells.get(cellKey(os, backend));
    const status = cell?.status ?? 'missing';
    if (status === 'pass') pass += 1;
    if (status === 'error') error += 1;
    if (status === 'excluded') excluded += 1;
    if (status === 'missing') missing += 1;
    if (cell?.regression) regressions += 1;
  }

  const status = error > 0
    ? 'error'
    : missing > 0
    ? 'missing'
    : pass > 0
    ? 'pass'
    : excluded > 0
    ? 'excluded'
    : 'missing';
  const regressionLabel = regressions ? ` ${regressions}R` : '';
  const excludedLabel = excluded ? ` ${excluded}EX` : '';
  return {
    status,
    label: `${error}E${regressionLabel}${excludedLabel} ${pass}P${missing ? ` ${missing}-` : ''}`,
  };
}

async function openLogs(record: ToolchainResultRecord | undefined, label: string) {
  let content = '';
  if (!record) {
    content = `No ${label} result record.`;
  } else {
    content += `${label}\n`;
    content += `submodule: ${record.submodule_path}\n`;
    content += `module: ${record.module_path}\n`;
    content += `commit: ${record.commit_sha ?? '-'}\n`;
    content += `os/backend: ${record.os}/${record.backend}\n`;
    content += `status: ${record.status}\n`;
    content += `working_directory: ${record.working_directory}\n`;
    if (record.expanded_command) {
      content += `command: ${
        Array.isArray(record.expanded_command) ? record.expanded_command.join(' ') : record.expanded_command
      }\n`;
    }
    const env = formatEnv(record.env);
    if (env) {
      content += `env:\n${env}\n`;
    }
    if (record.exit_code !== undefined) content += `exit_code: ${record.exit_code}\n`;
    if (record.elapsed !== undefined) content += `elapsed: ${record.elapsed}s\n`;
    if (record.reason) content += `reason: ${record.reason}\n`;
    content += '\n';

    if (record.stderr_path || record.stdout_path) {
      try {
        if (record.stderr_path) {
          const stderr = await fetch(record.stderr_path);
          content += `STDERR:\n${stderr.ok ? await stderr.text() : `Failed to fetch ${record.stderr_path}`}\n\n`;
        }
        if (record.stdout_path) {
          const stdout = await fetch(record.stdout_path);
          content += `STDOUT:\n${stdout.ok ? await stdout.text() : `Failed to fetch ${record.stdout_path}`}\n`;
        }
      } catch (error) {
        content += `Failed to fetch logs: ${error instanceof Error ? error.message : String(error)}\n`;
      }
    }
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf8' });
  const url = URL.createObjectURL(blob);
  const tab = globalThis.open(url, '_blank');
  if (tab) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StatusCell({ status, label, title, record, period, regression }: {
  status: CellStatus;
  label: string;
  title: string;
  record?: ToolchainResultRecord;
  period?: string;
  regression?: boolean;
}) {
  const onClick = record ? () => openLogs(record, period ?? 'result') : undefined;
  const cursor = record ? 'pointer' : 'default';
  const border = regression ? '2px solid #991b1b' : '1px solid #cbd5e1';

  return html`
    <td
      title="${title}"
      onClick="${onClick}"
      style="border: ${border}; padding: 5px 6px; text-align: center; background: ${STATUS_COLORS[
        status
      ]}; color: ${STATUS_TEXT_COLORS[
        status
      ]}; font-size: 11px; font-weight: 700; cursor: ${cursor}; white-space: nowrap;"
    >
      ${label}
    </td>
  `;
}

function ExpandedRows({ row }: { row: RowData }) {
  return html`
    <div style="padding: 10px 12px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed;">
        <thead>
          <tr style="background: #334155; color: white;">
            <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left; width: 130px;">OS</th>
            <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left; width: 90px;">Backend</th>
            <th style="padding: 6px; border: 1px solid #cbd5e1;">Current</th>
            <th style="padding: 6px; border: 1px solid #cbd5e1;">Previous</th>
            <th style="padding: 6px; border: 1px solid #cbd5e1; width: 76px;">Reg.</th>
            <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left;">Commit</th>
            <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left;">Elapsed</th>
            <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left;">Reason</th>
          </tr>
        </thead>
        <tbody>
          ${DASHBOARD_OSES.flatMap((os) =>
            DASHBOARD_BACKENDS.map((backend) => {
              const cell = row.cells.get(cellKey(os, backend));
              const current = cell?.current;
              const previous = cell?.previous;
              const status = cell?.status ?? 'missing';
              const previousStatus = cell?.previousStatus ?? 'missing';
              const reason = current?.reason ?? '';
              const elapsed = current?.elapsed === undefined ? '-' : `${current.elapsed}s`;
              const commit = `${shortCommit(current?.commit_sha)} / ${shortCommit(previous?.commit_sha)}`;

              return html`
                <tr>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${os}</td>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${backend}</td>
                  <${StatusCell}
                    status="${status}"
                    label="${STATUS_LABELS[status]}"
                    title="${os}/${backend}/current"
                    record="${current}"
                    period="current"
                    regression="${cell?.regression}"
                  />
                  <${StatusCell}
                    status="${previousStatus}"
                    label="${STATUS_LABELS[previousStatus]}"
                    title="${os}/${backend}/previous"
                    record="${previous}"
                    period="previous"
                  />
                  <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center; font-weight: 700;">
                    ${cell?.regression ? 'R' : ''}
                  </td>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${commit}</td>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${elapsed}</td>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; color: #334155;">${reason}</td>
                </tr>
              `;
            })
          )}
        </tbody>
      </table>
    </div>
  `;
}

function App() {
  const [data, setData] = useState<DashboardData>(emptyDashboardData());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function fetchAll() {
      const next = emptyDashboardData();
      await Promise.all(
        DASHBOARD_OSES.flatMap((os) => [
          (async () => {
            try {
              next.current[os] = await readJsonl(await fetch(`data/toolchain/current/${os}/data.jsonl`));
            } catch (error) {
              console.error(`Failed to fetch current data for ${os}:`, error);
            }
          })(),
          (async () => {
            try {
              next.previous[os] = await readJsonl(await fetch(`data/toolchain/previous/${os}/data.jsonl`));
            } catch (error) {
              console.error(`Failed to fetch previous data for ${os}:`, error);
            }
          })(),
        ]),
      );
      setData(next);
      setLoading(false);
    }

    fetchAll();
  }, []);

  const rows = useMemo(() => buildRows(data), [data]);
  const filteredRows = useMemo(() => filterRows(rows, filter, search), [rows, filter, search]);
  const counts = useMemo(() => countRows(rows), [rows]);
  const generatedAtRaw = DASHBOARD_OSES.map((os) => data.current[os].metadata?.generated_at).filter((
    value,
  ): value is string => Boolean(value)).sort().at(-1);
  const generatedAt = generatedAtRaw ? formatGeneratedAt(generatedAtRaw) : '-';
  const toolchainVersion = DASHBOARD_OSES.map((os) => data.current[os].metadata?.toolchainVersion).find((
    version,
  ): version is string[] => Array.isArray(version) && version.length > 0);
  const toolchain = formatToolchainVersion(toolchainVersion);

  if (loading) {
    return html`
      <div style="padding: 20px; font-family: ui-sans-serif, system-ui;">Loading...</div>
    `;
  }

  return html`
    <div
      style="padding: 20px; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a;"
    >
      <div style="margin-bottom: 10px;">
        <h1 style="margin: 0; font-size: 26px;">Toolchain Regression Dashboard</h1>
        <div style="margin-top: 3px; color: #475569; font-size: 13px;">MoonBit current vs previous test status</div>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; align-items: stretch;">
        ${([
          ['regression', 'Regressions', counts.regression],
          ['error', 'Errors', counts.error],
          ['excluded', 'Excluded', counts.excluded],
          ['pass', 'Passing', counts.pass],
          ['all', 'Total', counts.all],
        ] as const).map(([key, label, value]) =>
          html`
            <button
              onClick="${() => setFilter(key)}"
              style="min-width: 112px; border: 1px solid ${filter === key
                ? '#0f172a'
                : '#cbd5e1'}; border-radius: 6px; background: ${filter === key
                ? '#0f172a'
                : '#ffffff'}; color: ${filter === key
                ? '#ffffff'
                : '#0f172a'}; padding: 8px 10px; cursor: pointer; text-align: left;"
            >
              <div style="font-size: 11px; font-weight: 700;">${label}</div>
              <div style="font-size: 20px; font-weight: 800; line-height: 1.1;">${value}</div>
            </button>
          `
        )}

        <div
          style="min-width: 320px; max-width: 680px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; background: #f8fafc; font-size: 12px; margin-left: auto;"
        >
          <div><strong>Generated</strong> <time title="${generatedAtRaw ?? ''}">${generatedAt}</time></div>
          <div style="margin-top: 4px;">
            <strong>Toolchain</strong>
            <pre
              style="margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace; font-size: 11px; line-height: 1.35;"
            >${toolchain}</pre>
          </div>
        </div>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px;">
        <input
          type="text"
          placeholder="Search submodule, module, commit"
          value="${search}"
          onInput="${(event: Event) => setSearch((event.target as HTMLInputElement).value)}"
          style="margin-left: auto; min-width: 260px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 7px 9px;"
        />
      </div>

      <div style="margin-bottom: 8px; font-size: 12px; color: #475569;">
        Showing ${filteredRows.length} of ${rows.length} modules
      </div>

      <table style="width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed;">
        <thead>
          <tr style="background: #1e293b; color: white;">
            <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: left; width: 260px;">Submodule</th>
            <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: left; width: 160px;">Module</th>
            ${DASHBOARD_OSES.map((os) =>
              html`
                <th style="padding: 8px; border: 1px solid #cbd5e1;">${os}</th>
              `
            )}
            <th style="padding: 8px; border: 1px solid #cbd5e1; width: 82px;">Reg.</th>
            <th style="padding: 8px; border: 1px solid #cbd5e1; width: 82px;">Overall</th>
            <th style="padding: 8px; border: 1px solid #cbd5e1; width: 84px;">Details</th>
          </tr>
        </thead>
        <tbody>
          ${filteredRows.map((row, index) => {
            const isExpanded = !!expanded[row.key];
            return html`
              <tr style="background: ${index % 2 === 0 ? '#ffffff' : '#f8fafc'};">
                <td
                  title="${row.submodule_path}"
                  style="padding: 7px; border: 1px solid #cbd5e1; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
                >
                  ${row.submodule_path}
                </td>
                <td style="padding: 7px; border: 1px solid #cbd5e1; font-family: monospace;">${row.module_path}</td>
                ${DASHBOARD_OSES.map((os) => {
                  const summary = osSummary(row, os);
                  return html`
                    <${StatusCell}
                      status="${summary.status}"
                      label="${summary.label}"
                      title="${os}"
                    />
                  `;
                })}
                <td style="padding: 7px; border: 1px solid #cbd5e1; text-align: center; font-weight: 800;">
                  ${row.regressionCount || ''}
                </td>
                <${StatusCell}
                  status="${row.status}"
                  label="${STATUS_LABELS[row.status]}"
                  title="overall"
                />
                <td style="padding: 7px; border: 1px solid #cbd5e1; text-align: center;">
                  <button
                    onClick="${() => setExpanded((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}"
                    style="border: 1px solid #cbd5e1; border-radius: 6px; background: white; cursor: pointer; font-size: 11px; padding: 4px 8px;"
                  >
                    ${isExpanded ? 'Hide' : 'Show'}
                  </button>
                </td>
              </tr>
              ${isExpanded
                ? html`
                  <tr>
                    <td colspan="8" style="padding: 0; border: 1px solid #cbd5e1; border-top: 0;">
                      <${ExpandedRows} row="${row}" />
                    </td>
                  </tr>
                `
                : ''}
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}

render(
  html`
    <${App} />
  `,
  document.body,
);
