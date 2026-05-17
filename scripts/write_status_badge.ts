import { parseArgs } from '@std/cli/parse-args';
import { dirname } from '@std/path/dirname';
import { join } from '@std/path/join';
import { DASHBOARD_OSES, emptyDashboardData } from '../lib/dashboard_data.ts';
import { renderDashboardStatusSvg, summarizeDashboardStatus } from '../lib/dashboard_status.ts';
import type { ToolchainMetadata, ToolchainOS, ToolchainResultRecord } from '../lib/toolchain_types.ts';

function showHelp() {
  console.log(`
Write dashboard status badge

USAGE:
    deno run -A scripts/write_status_badge.ts [OPTIONS]

OPTIONS:
    --data-dir <PATH>    Toolchain data directory [default: data/toolchain]
    --out <PATH>         Badge SVG output path [default: <data-dir>/status.svg]
    -h, --help           Show this help message
`);
}

async function readCurrentJsonl(
  dataDir: string,
  os: ToolchainOS,
): Promise<{ metadata: ToolchainMetadata | null; results: ToolchainResultRecord[] }> {
  const path = join(dataDir, 'current', os, 'data.jsonl');
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { metadata: null, results: [] };
    }
    throw error;
  }

  const values = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  return {
    metadata: (values[0] as ToolchainMetadata | undefined) ?? null,
    results: values.slice(1) as ToolchainResultRecord[],
  };
}

export async function main(args = Deno.args): Promise<void> {
  const parsed = parseArgs(args, {
    string: ['data-dir', 'out'],
    boolean: ['help'],
    alias: { h: 'help' },
  });

  if (parsed.help) {
    showHelp();
    return;
  }

  const dataDir = parsed['data-dir'] ?? 'data/toolchain';
  const outPath = parsed.out ?? join(dataDir, 'status.svg');
  const data = emptyDashboardData();

  for (const os of DASHBOARD_OSES) {
    data.current[os] = await readCurrentJsonl(dataDir, os);
  }

  const summary = summarizeDashboardStatus(data);
  await Deno.mkdir(dirname(outPath), { recursive: true });
  await Deno.writeTextFile(outPath, renderDashboardStatusSvg(summary));
  console.log(
    `Wrote ${summary.status} dashboard badge to ${outPath} ` +
      `(${summary.passCount} pass, ${summary.errorCount} error, ${summary.missingCount} missing, ${summary.excludedCount} excluded).`,
  );
}

if (import.meta.main) {
  await main();
}
