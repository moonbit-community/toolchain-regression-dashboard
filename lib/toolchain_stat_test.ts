import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { mkdir, writeFile, rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandSubmodulesConfig } from './submodule_config.ts';
import { groupTasksBySubmodule, toolchainStat } from './toolchain_stat.ts';
import { sha256Hex } from './log.ts';
import { SubmodulesConfig } from './toolchain_types.ts';
import { stringify } from 'yaml';

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Assertion failed:\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

function assertIncludes(value: string | undefined, expected: string) {
  if (!value?.includes(expected)) {
    throw new Error(`Expected "${value}" to include "${expected}"`);
  }
}

async function run(command: string, args: string[], cwd: string) {
  await promisify(execFile)(command, args, { cwd });
}

async function initGitRepo(path: string) {
  await mkdir(path, { recursive: true });
  await run('git', ['init'], path);
  await run('git', ['config', 'user.email', 'test@example.com'], path);
  await run('git', ['config', 'user.name', 'Test User'], path);
  await writeFile(join(path, 'README.md'), '# test\n');
  await run('git', ['add', 'README.md'], path);
  await run('git', ['commit', '-m', 'initial'], path);
}

test('groupTasksBySubmodule groups tasks by submodule path', () => {
  const config: SubmodulesConfig = {
    schema_version: 1,
    defaults: {
      matrix: { os: ['linux-x64'], backends: ['wasm', 'js'] },
      test: { argv: ['moon', 'test', '--target', '{backend}'] },
    },
    submodules: {
      'deps/a': {},
      'deps/b': {},
    },
  };

  const tasks = expandSubmodulesConfig(config, 'linux-x64');
  const groups = groupTasksBySubmodule(tasks);

  assertEquals(
    groups.map((group) => group.map((task) => `${task.submodule_path}:${task.backend}`)),
    [
      ['deps/a:wasm', 'deps/a:js'],
      ['deps/b:wasm', 'deps/b:js'],
    ],
  );
});

test('toolchainStat records Error when submodule commit cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-dashboard-'));
  const configPath = join(root, 'submodules.yaml');
  const outDir = join(root, 'out');
  await writeFile(
    configPath,
    `
schema_version: 1
defaults:
  matrix:
    os: [linux-x64]
    backends: [wasm]
  test:
    argv: [moon, test]
submodules:
  deps/missing:
    {}
`,
  );

  try {
    const result = await toolchainStat({ config: configPath, outDir, os: 'linux-x64', workspaceRoot: root });
    assertEquals(result.result.length, 1);
    assertEquals(result.result[0].status, 'Error');
    assertIncludes(result.result[0].reason, 'Failed to read submodule commit');
    assertIncludes(await readFile(result.result[0].stderr_path!, 'utf8'), 'Submodule path does not exist');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('toolchainStat records pass and excluded test results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-dashboard-'));
  const submodule = join(root, 'deps/project');
  const configPath = join(root, 'submodules.yaml');
  const outDir = join(root, 'out');
  await initGitRepo(submodule);
  await writeFile(
    configPath,
    `
schema_version: 1
defaults:
  matrix:
    os: [linux-x64]
    backends: [wasm, native]
    exclude:
      - backend: native
  test:
    argv:
      - '${process.execPath.replaceAll("'", "''")}'
      - --eval
      - 'process.exit(0)'
submodules:
  deps/project:
    {}
`,
  );

  try {
    const result = await toolchainStat({ config: configPath, outDir, os: 'linux-x64', workspaceRoot: root });
    assertEquals(
      result.result.map((record) => `${record.backend}:${record.status}:${record.reason ?? ''}`),
      ['wasm:Pass:', 'native:Excluded:Excluded by matrix configuration.'],
    );
    assertEquals(result.result[0].commit_sha?.length, 40);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('toolchainStat writes stable log paths based on submodule, module, os, and backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'toolchain-dashboard-'));
  const submodule = join(root, 'deps/project');
  const configPath = join(root, 'submodules.yaml');
  const outDir = join(root, 'out');
  await initGitRepo(submodule);
  await writeFile(
    configPath,
    `
schema_version: 1
defaults:
  matrix:
    os: [linux-x64]
    backends: [wasm]
  test:
    argv:
      - '${process.execPath.replaceAll("'", "''")}'
      - --eval
      - 'console.log("out"); console.error("err"); process.exit(7)'
submodules:
  deps/project:
    {}
`,
  );

  try {
    const result = await toolchainStat({ config: configPath, outDir, os: 'linux-x64', workspaceRoot: root });
    const [record] = result.result;
    const prefix = (await sha256Hex('deps/project|.|linux-x64|wasm')).slice(0, 16);

    assertEquals(record.status, 'Error');
    assertEquals(record.exit_code, 7);
    assertEquals(record.stdout_path, join(outDir, 'logs', `${prefix}.stdout.log`).replaceAll('\\', '/'));
    assertEquals(record.stderr_path, join(outDir, 'logs', `${prefix}.stderr.log`).replaceAll('\\', '/'));
    assertEquals(await readFile(record.stdout_path!, 'utf8'), 'out\n');
    assertEquals(await readFile(record.stderr_path!, 'utf8'), 'err\n');
  } finally {
    await rm(root, { recursive: true });
  }
});

for (const scenario of [
  {
    name: 'inherits the environment and applies command overrides',
    command: {
      argv: [
        process.execPath,
        '--eval',
        'console.log([process.env.DASHBOARD_INHERITED, process.env.DASHBOARD_OVERRIDE, process.env.MOON_IGNORE_PREBUILD, process.env.MOON_NO_WORKSPACE].join("|"))',
      ],
      env: { DASHBOARD_OVERRIDE: 'override' },
    },
    status: 'Pass',
    stdout: 'inherited|override|1|1\n',
  },
  {
    name: 'records spawn failures without stopping collection',
    command: { argv: ['toolchain-dashboard-command-does-not-exist'] },
    status: 'Error',
    reason: 'ENOENT',
  },
  {
    name: 'terminates timed out commands and keeps their logs',
    command: {
      argv: [process.execPath, '--eval', 'console.log("started"); setInterval(() => {}, 1000)'],
      timeout_seconds: 2,
    },
    status: 'Error',
    stdout: 'started\n',
    reason: 'Command timed out after 2 seconds.',
  },
  {
    name: 'executes shell commands',
    command: { shell: 'echo shell-output' },
    status: 'Pass',
    stdout: 'shell-output\n',
  },
]) {
  test(`toolchainStat ${scenario.name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'toolchain-dashboard-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const inherited = process.env.DASHBOARD_INHERITED;
    process.env.DASHBOARD_INHERITED = 'inherited';
    t.after(() => {
      if (inherited === undefined) delete process.env.DASHBOARD_INHERITED;
      else process.env.DASHBOARD_INHERITED = inherited;
    });
    await initGitRepo(join(root, 'deps/project'));
    const configPath = join(root, 'submodules.yaml');
    await writeFile(
      configPath,
      stringify({
        schema_version: 1,
        defaults: { matrix: { os: ['linux-x64'], backends: ['wasm'] }, test: scenario.command },
        submodules: { 'deps/project': {} },
      }),
    );
    const { result } = await toolchainStat({
      config: configPath,
      outDir: join(root, 'out'),
      workspaceRoot: root,
      os: 'linux-x64',
    });
    assertEquals(result[0].status, scenario.status);
    if (scenario.stdout) {
      assertEquals((await readFile(result[0].stdout_path!, 'utf8')).replaceAll('\r\n', '\n'), scenario.stdout);
    }
    if (scenario.reason) assertIncludes(result[0].reason, scenario.reason);
  });
}
