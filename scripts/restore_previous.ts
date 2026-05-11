import { DASHBOARD_OSES, emptyDashboardData, regressionRowKeys, rowKey } from '../lib/dashboard_data.ts';
import type { ToolchainOS, ToolchainResultRecord } from '../lib/toolchain_types.ts';

type Period = 'current' | 'previous';

type PublishedJsonl = {
  period: Period;
  os: ToolchainOS;
  values: unknown[];
  results: ToolchainResultRecord[];
};

type PublishedData = Partial<Record<ToolchainOS, PublishedJsonl>>;

type RestoreStats = {
  restored: boolean;
  advancedRecords: number;
  preservedRecords: number;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

async function fetchText(url: string): Promise<string | undefined> {
  const response = await fetch(url, { cache: 'no-store' }).catch(() => undefined);
  if (!response?.ok) return undefined;
  return await response.text();
}

function parseJsonl(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function fetchPublishedJsonl(
  baseUrl: string,
  period: Period,
  os: ToolchainOS,
): Promise<PublishedJsonl | undefined> {
  const prefix = `data/toolchain/${period}/${os}`;
  const text = await fetchText(`${baseUrl}/${prefix}/data.jsonl`);
  if (text === undefined) return undefined;

  const values = parseJsonl(text);
  return {
    period,
    os,
    values,
    results: values.slice(1) as ToolchainResultRecord[],
  };
}

function publishedRegressionRowKeys(current: PublishedData, previous: PublishedData): Set<string> {
  const data = emptyDashboardData();
  for (const os of DASHBOARD_OSES) {
    data.current[os].results = current[os]?.results ?? [];
    data.previous[os].results = previous[os]?.results ?? [];
  }
  return regressionRowKeys(data);
}

async function copyLog(baseUrl: string, oldPath: string): Promise<string> {
  const newPath = oldPath.replace('data/toolchain/current/', 'data/toolchain/previous/');
  const text = await fetchText(`${baseUrl}/${oldPath}`);
  if (text !== undefined) {
    await Deno.mkdir(newPath.split('/').slice(0, -1).join('/'), { recursive: true });
    await Deno.writeTextFile(newPath, text);
  }
  return newPath;
}

async function rewriteLogPaths(baseUrl: string, value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const copy = { ...value } as Record<string, unknown>;
  if (typeof copy.stdout_path === 'string') {
    copy.stdout_path = await copyLog(baseUrl, copy.stdout_path);
  }
  if (typeof copy.stderr_path === 'string') {
    copy.stderr_path = await copyLog(baseUrl, copy.stderr_path);
  }
  return copy;
}

async function restoreOs(
  baseUrl: string,
  os: ToolchainOS,
  current: PublishedJsonl | undefined,
  previous: PublishedJsonl | undefined,
  preserveRowKeys: Set<string>,
): Promise<RestoreStats> {
  const metadata = current?.values[0] ?? previous?.values[0];
  if (metadata === undefined) {
    return { restored: false, advancedRecords: 0, preservedRecords: 0 };
  }

  const previousPrefix = `data/toolchain/previous/${os}`;
  await Deno.mkdir(previousPrefix, { recursive: true });
  const restored = [JSON.stringify(metadata)];
  let advancedRecords = 0;
  let preservedRecords = 0;

  for (const record of current?.results ?? []) {
    if (preserveRowKeys.has(rowKey(record))) continue;
    restored.push(JSON.stringify(await rewriteLogPaths(baseUrl, record)));
    advancedRecords += 1;
  }
  for (const record of previous?.results ?? []) {
    if (!preserveRowKeys.has(rowKey(record))) continue;
    restored.push(JSON.stringify(await rewriteLogPaths(baseUrl, record)));
    preservedRecords += 1;
  }

  await Deno.writeTextFile(`${previousPrefix}/data.jsonl`, `${restored.join('\n')}\n`);
  return { restored: true, advancedRecords, preservedRecords };
}

export async function main(args = Deno.args): Promise<void> {
  const baseUrl = args[0] ? normalizeBaseUrl(args[0]) : '';
  if (!baseUrl) {
    console.log('No published Pages URL configured; previous data will be empty.');
    return;
  }

  const current: PublishedData = {};
  const previous: PublishedData = {};
  for (const os of DASHBOARD_OSES) {
    current[os] = await fetchPublishedJsonl(baseUrl, 'current', os);
    previous[os] = await fetchPublishedJsonl(baseUrl, 'previous', os);
  }

  const preserveRowKeys = publishedRegressionRowKeys(current, previous);
  console.log(
    preserveRowKeys.size > 0
      ? `Published data has regressions in ${preserveRowKeys.size} rows; preserving those previous rows.`
      : 'Published data has no regressions; advancing all previous data to published current.',
  );

  for (const os of DASHBOARD_OSES) {
    const stats = await restoreOs(baseUrl, os, current[os], previous[os], preserveRowKeys);
    console.log(
      `${stats.restored ? 'Restored' : 'Skipped'} previous data for ${os} ` +
        `(${stats.preservedRecords} preserved records, ${stats.advancedRecords} advanced records)`,
    );
  }
}

if (import.meta.main) {
  await main();
}
