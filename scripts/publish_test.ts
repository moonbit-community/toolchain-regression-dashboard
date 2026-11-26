import { deepStrictEqual, match, ok } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DASHBOARD_BACKENDS, DASHBOARD_OSES } from '../lib/dashboard_data.ts';
import { writeToolchainJsonl } from '../lib/toolchain_stat.ts';
import type { ToolchainMetadata, ToolchainResultRecord } from '../lib/toolchain_types.ts';
import { main as restorePrevious } from './restore_previous.ts';

const exec = promisify(execFile);
const metadata: ToolchainMetadata = {
  runId: '123',
  runNumber: '1',
  generated_at: '2026-11-26T00:00:00Z',
  toolchainVersion: ['test pre-release'],
};

test('Node CLI writes schema and a passing badge from collected JSONL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loader = import.meta.resolve('tsx');
  const main = fileURLToPath(new URL('../main.ts', import.meta.url));
  const badge = fileURLToPath(new URL('./write_status_badge.ts', import.meta.url));
  const help = await exec(process.execPath, ['--import', loader, main, 'stat', '--help'], { cwd: root });
  match(help.stdout, /max-concurrent-submodules/);
  await exec(process.execPath, ['--import', loader, main, 'schema'], { cwd: root });
  const schema = JSON.parse(await readFile(join(root, 'resources/submodules.schema.json'), 'utf8'));
  ok(schema.properties.submodules);
  for (const os of DASHBOARD_OSES) {
    const records = DASHBOARD_BACKENDS.map((backend): ToolchainResultRecord => ({
      submodule_path: 'deps/example',
      module_path: '.',
      os,
      backend,
      status: 'Pass',
      working_directory: '.',
    }));
    await writeToolchainJsonl(join(root, 'data/toolchain/current', os, 'data.jsonl'), metadata, records);
  }
  await exec(process.execPath, ['--import', loader, badge], { cwd: root });
  const svg = await readFile(join(root, 'data/toolchain/status.svg'), 'utf8');
  match(svg, /passing/);
  match(svg, /#2ea44f/);
});

test('restore preserves regressed baselines and advances healthy rows with their logs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-restore-'));
  const originalCwd = process.cwd();
  t.after(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });
  const record = (name: string, status: ToolchainResultRecord['status'], period: string): ToolchainResultRecord => ({
    submodule_path: `deps/${name}`,
    module_path: '.',
    os: 'linux-x64',
    backend: 'wasm',
    status,
    working_directory: '.',
    stdout_path: `data/toolchain/${period}/linux-x64/logs/${name}.stdout.log`,
  });
  const current = [record('regressed', 'Error', 'current'), record('healthy', 'Pass', 'current')];
  current[1].stdout_path = current[1].stdout_path!.replaceAll('/', '\\');
  const previous = [record('regressed', 'Pass', 'previous'), record('healthy', 'Error', 'previous')];
  const urls = new Map<string, string>([
    ['data/toolchain/current/linux-x64/data.jsonl', [metadata, ...current].map((v) => JSON.stringify(v)).join('\n')],
    ['data/toolchain/previous/linux-x64/data.jsonl', [metadata, ...previous].map((v) => JSON.stringify(v)).join('\n')],
    ['data/toolchain/current/linux-x64/logs/healthy.stdout.log', 'new healthy log'],
    ['data/toolchain/previous/linux-x64/logs/regressed.stdout.log', 'old passing log'],
  ]);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = String(input).replace('https://example.test/dashboard/', '');
    return new Response(urls.get(path) ?? '', { status: urls.has(path) ? 200 : 404 });
  });
  process.chdir(root);
  await restorePrevious(['https://example.test/dashboard/']);
  const text = await readFile('data/toolchain/previous/linux-x64/data.jsonl', 'utf8');
  const [restoredMetadata, ...records] = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  deepStrictEqual(restoredMetadata, metadata);
  deepStrictEqual(
    records.map((r) => [r.submodule_path, r.status]),
    [
      ['deps/healthy', 'Pass'],
      ['deps/regressed', 'Pass'],
    ],
  );
  deepStrictEqual(await readFile(records[0].stdout_path, 'utf8'), 'new healthy log');
  deepStrictEqual(await readFile(records[1].stdout_path, 'utf8'), 'old passing log');
});
