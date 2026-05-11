import { join } from '@std/path/join';
import { expandSubmodulesConfig } from './submodule_config.ts';
import { groupTasksBySubmodule, toolchainStat } from './toolchain_stat.ts';
import { sha256Hex } from './log.ts';
import { SubmodulesConfig } from './toolchain_types.ts';

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
  const process = new Deno.Command(command, {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  });
  const output = await process.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`);
  }
}

async function initGitRepo(path: string) {
  await Deno.mkdir(path, { recursive: true });
  await run('git', ['init'], path);
  await run('git', ['config', 'user.email', 'test@example.com'], path);
  await run('git', ['config', 'user.name', 'Test User'], path);
  await Deno.writeTextFile(join(path, 'README.md'), '# test\n');
  await run('git', ['add', 'README.md'], path);
  await run('git', ['commit', '-m', 'initial'], path);
}

Deno.test('groupTasksBySubmodule groups tasks by submodule path', () => {
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

  assertEquals(groups.map((group) => group.map((task) => `${task.submodule_path}:${task.backend}`)), [
    ['deps/a:wasm', 'deps/a:js'],
    ['deps/b:wasm', 'deps/b:js'],
  ]);
});

Deno.test('toolchainStat records Error when submodule commit cannot be read', async () => {
  const root = await Deno.makeTempDir();
  const configPath = join(root, 'submodules.yaml');
  const outDir = join(root, 'out');
  await Deno.writeTextFile(
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
    assertIncludes(await Deno.readTextFile(result.result[0].stderr_path!), 'Submodule path does not exist');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('toolchainStat records pass and excluded test results', async () => {
  const root = await Deno.makeTempDir();
  const submodule = join(root, 'deps/project');
  const configPath = join(root, 'submodules.yaml');
  const outDir = join(root, 'out');
  await initGitRepo(submodule);
  await Deno.writeTextFile(
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
      - '${Deno.execPath().replaceAll('\\', '\\\\')}'
      - eval
      - 'Deno.exit(0)'
submodules:
  deps/project:
    {}
`,
  );

  try {
    const result = await toolchainStat({ config: configPath, outDir, os: 'linux-x64', workspaceRoot: root });
    assertEquals(result.result.map((record) => `${record.backend}:${record.status}:${record.reason ?? ''}`), [
      'wasm:Pass:',
      'native:Excluded:Excluded by matrix configuration.',
    ]);
    assertEquals(result.result[0].commit_sha?.length, 40);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('toolchainStat writes stable log paths based on submodule, module, os, and backend', async () => {
  const root = await Deno.makeTempDir();
  const submodule = join(root, 'deps/project');
  const configPath = join(root, 'submodules.yaml');
  const outDir = join(root, 'out');
  await initGitRepo(submodule);
  await Deno.writeTextFile(
    configPath,
    `
schema_version: 1
defaults:
  matrix:
    os: [linux-x64]
    backends: [wasm]
  test:
    argv:
      - '${Deno.execPath().replaceAll('\\', '\\\\')}'
      - eval
      - 'console.log("out"); console.error("err"); Deno.exit(7)'
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
    assertEquals(record.stdout_path, join(outDir, 'logs', `${prefix}.stdout.log`));
    assertEquals(record.stderr_path, join(outDir, 'logs', `${prefix}.stderr.log`));
    assertEquals(await Deno.readTextFile(record.stdout_path!), 'out\n');
    assertEquals(await Deno.readTextFile(record.stderr_path!), 'err\n');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
