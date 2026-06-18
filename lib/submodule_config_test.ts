import {
  expandCommand,
  expandSubmodulesConfig,
  loadSubmodulesConfig,
  normalizeWorkspaceRelativePath,
} from './submodule_config.ts';
import { SubmodulesConfig, SubmodulesConfigSchema } from './toolchain_types.ts';

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Assertion failed:\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

function assertThrows(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`Expected error matching ${pattern}, got: ${message}`);
    }
    return;
  }
  throw new Error(`Expected error matching ${pattern}`);
}

Deno.test('normalizeWorkspaceRelativePath normalizes relative submodule paths', () => {
  assertEquals(normalizeWorkspaceRelativePath(' ./deps\\parser// '), 'deps/parser');
  assertEquals(normalizeWorkspaceRelativePath('src/./module'), 'src/module');
  assertEquals(normalizeWorkspaceRelativePath(''), '.');
});

Deno.test('normalizeWorkspaceRelativePath rejects URLs, absolute paths, and parent traversal', () => {
  assertThrows(() => normalizeWorkspaceRelativePath('https://github.com/example/project'), /workspace-relative/);
  assertThrows(() => normalizeWorkspaceRelativePath('/tmp/project'), /workspace-relative/);
  assertThrows(() => normalizeWorkspaceRelativePath('../project'), /must not contain/);
});

Deno.test('loadSubmodulesConfig rejects duplicate paths after normalization', async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/submodules.yaml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
defaults:
  matrix:
    os: [linux-x64]
    backends: [wasm]
  test:
    argv: [moon, test]
submodules:
  deps/parser:
    {}
  ./deps/parser/:
    {}
`,
  );

  try {
    await loadSubmodulesConfig(path);
    throw new Error('Expected duplicate submodule path error');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Duplicate submodule path/.test(message)) throw error;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('loadSubmodulesConfig rejects URL submodule keys', async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/submodules.yaml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
defaults:
  matrix:
    os: [linux-x64]
    backends: [wasm]
  test:
    argv: [moon, test]
submodules:
  https://github.com/example/project:
    {}
`,
  );

  try {
    await loadSubmodulesConfig(path);
    throw new Error('Expected URL submodule path error');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/workspace-relative/.test(message)) throw error;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('SubmodulesConfigSchema rejects old repo, branch, check, and run_after fields', () => {
  assertEquals(
    SubmodulesConfigSchema.safeParse({
      schema_version: 1,
      defaults: {
        matrix: { os: ['linux-x64'], backends: ['wasm'] },
        commands: { check: { argv: ['moon', 'check'] }, test: { argv: ['moon', 'test'] } },
      },
      repos: {},
    }).success,
    false,
  );

  assertEquals(
    SubmodulesConfigSchema.safeParse({
      schema_version: 1,
      defaults: {
        matrix: { os: ['linux-x64'], backends: ['wasm'] },
        test: { argv: ['moon', 'test'], run_after: 'check_passed' },
      },
      submodules: {
        'deps/parser': { branch: 'main' },
      },
    }).success,
    false,
  );
});

Deno.test('SubmodulesConfigSchema rejects skip test commands', () => {
  assertEquals(
    SubmodulesConfigSchema.safeParse({
      schema_version: 1,
      defaults: {
        matrix: { os: ['linux-x64'], backends: ['wasm'] },
        test: { skip: true },
      },
      submodules: {
        'deps/parser': {},
      },
    }).success,
    false,
  );
});

Deno.test('expandSubmodulesConfig propagates resource_intensive flag to tasks', () => {
  const config: SubmodulesConfig = {
    schema_version: 1,
    defaults: {
      matrix: {
        os: ['linux-x64'],
        backends: ['wasm', 'js'],
      },
      test: {
        argv: ['moon', 'test', '--target', '{backend}'],
      },
    },
    submodules: {
      'deps/heavy': {
        resource_intensive: true,
        modules: [
          { path: '.' },
          { path: 'examples/foo' },
        ],
      },
      'deps/light': {},
      'deps/explicit-light': {
        resource_intensive: false,
      },
    },
  };

  const tasks = expandSubmodulesConfig(config, 'linux-x64');
  const heavyTasks = tasks.filter((task) => task.submodule_path === 'deps/heavy');
  const lightTasks = tasks.filter((task) => task.submodule_path !== 'deps/heavy');

  assertEquals(heavyTasks.length, 4);
  assertEquals(heavyTasks.every((task) => task.resource_intensive === true), true);
  assertEquals(lightTasks.every((task) => task.resource_intensive === false), true);
});

Deno.test('expandSubmodulesConfig preserves inherited test command when override only sets env', () => {
  const config: SubmodulesConfig = {
    schema_version: 1,
    defaults: {
      matrix: {
        os: ['linux-x64'],
        backends: ['js'],
      },
      test: {
        argv: ['moon', 'test', '--target', '{backend}'],
        timeout_seconds: 1200,
      },
    },
    submodules: {
      'deps/parser': {
        test: {
          env: { NODE_OPTIONS: '--max-old-space-size=4096' },
        },
      },
    },
  };

  const [task] = expandSubmodulesConfig(config, 'linux-x64');

  assertEquals(task.test.argv, ['moon', 'test', '--target', '{backend}']);
  assertEquals(task.test.env, { NODE_OPTIONS: '--max-old-space-size=4096' });
  assertEquals(task.test.timeout_seconds, 1200);
});

Deno.test('loadSubmodulesConfig applies default overrides to matching tasks', async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/submodules.yaml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
defaults:
  matrix:
    os: [linux-x64, macos-arm64, windows-x64]
    backends: [wasm, native]
  test:
    argv: [moon, test, --target, '{backend}']
    env:
      BASE: "1"
  overrides:
    - match:
        os: [linux-x64, macos-arm64]
        backends: [native]
      env:
        MOONBIT_NEW_NATIVE: "1"
submodules:
  deps/parser:
    overrides:
      - match:
          os: [linux-x64]
          backends: [native]
        env:
          PROJECT: parser
`,
  );

  try {
    const config = await loadSubmodulesConfig(path);
    const linuxTasks = expandSubmodulesConfig(config, 'linux-x64');
    const macosTasks = expandSubmodulesConfig(config, 'macos-arm64');
    const windowsTasks = expandSubmodulesConfig(config, 'windows-x64');

    assertEquals(linuxTasks.find((task) => task.backend === 'native')?.test.env, {
      MOONBIT_NEW_NATIVE: '1',
      PROJECT: 'parser',
      BASE: '1',
    });
    assertEquals(macosTasks.find((task) => task.backend === 'native')?.test.env, {
      MOONBIT_NEW_NATIVE: '1',
      BASE: '1',
    });
    assertEquals(windowsTasks.find((task) => task.backend === 'native')?.test.env, { BASE: '1' });
    assertEquals(linuxTasks.find((task) => task.backend === 'wasm')?.test.env, { BASE: '1' });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('resources config runs both native modes on linux and macos', async () => {
  const configPath = new URL('../resources/submodules.yaml', import.meta.url).pathname;
  const config = await loadSubmodulesConfig(configPath);
  const linuxTasks = expandSubmodulesConfig(config, 'linux-x64');
  const macosTasks = expandSubmodulesConfig(config, 'macos-arm64');
  const windowsTasks = expandSubmodulesConfig(config, 'windows-x64');
  const windowsTasksWithExcluded = expandSubmodulesConfig(config, 'windows-x64', { includeExcluded: true });

  const linuxNativeTasks = linuxTasks.filter((task) => task.backend === 'native');
  const macosNativeTasks = macosTasks.filter((task) => task.backend === 'native');
  const linuxNewNativeTasks = linuxTasks.filter((task) => String(task.backend) === 'new-native');
  const macosNewNativeTasks = macosTasks.filter((task) => String(task.backend) === 'new-native');

  assertEquals(linuxNativeTasks.length > 0, true);
  assertEquals(macosNativeTasks.length > 0, true);
  assertEquals(linuxNewNativeTasks.length, linuxNativeTasks.length);
  assertEquals(macosNewNativeTasks.length, macosNativeTasks.length);
  assertEquals(linuxNativeTasks.every((task) => task.test.env.MOONBIT_NEW_NATIVE === undefined), true);
  assertEquals(macosNativeTasks.every((task) => task.test.env.MOONBIT_NEW_NATIVE === undefined), true);
  assertEquals(linuxNewNativeTasks.every((task) => task.test.env.MOONBIT_NEW_NATIVE === '1'), true);
  assertEquals(macosNewNativeTasks.every((task) => task.test.env.MOONBIT_NEW_NATIVE === '1'), true);
  assertEquals(
    [...linuxNewNativeTasks, ...macosNewNativeTasks].every((task) =>
      JSON.stringify(expandCommand(task.test, {
        backend: task.backend,
        os: task.os,
        submodule: task.submodule_path,
        module: task.module_path,
        working_directory: task.test.working_directory,
      })) === JSON.stringify(['moon', 'test', '--target', 'native'])
    ),
    true,
  );
  assertEquals(windowsTasks.every((task) => task.test.env.MOONBIT_NEW_NATIVE === undefined), true);
  assertEquals(windowsTasks.every((task) => String(task.backend) !== 'new-native'), true);
  assertEquals(
    windowsTasksWithExcluded
      .filter((task) => String(task.backend) === 'new-native')
      .every((task) => task.excluded === true),
    true,
  );
  assertEquals(
    [...linuxTasks, ...macosTasks]
      .filter((task) => task.backend !== 'native' && String(task.backend) !== 'new-native')
      .every((task) => task.test.env.MOONBIT_NEW_NATIVE === undefined),
    true,
  );
});

Deno.test('expandSubmodulesConfig applies module matrix, exclude, env merge, and ordered overrides', () => {
  const config: SubmodulesConfig = {
    schema_version: 1,
    defaults: {
      matrix: {
        os: ['linux-x64', 'windows-x64'],
        backends: ['wasm', 'native'],
      },
      test: {
        argv: ['moon', 'test', '--target', '{backend}', '--directory', '{working_directory}'],
        timeout_seconds: 1200,
        env: { BASE: '1' },
      },
    },
    submodules: {
      'deps/project': {
        matrix: {
          exclude: [{ os: 'windows-x64', backend: 'native' }],
        },
        modules: [
          {
            path: '.',
          },
          {
            path: 'examples/foo',
            matrix: {
              backends: ['wasm'],
            },
          },
        ],
        overrides: [
          {
            match: { os: ['linux-x64'], backends: ['native'] },
            env: { NATIVE_ONLY: '1' },
            test: {
              shell: './scripts/native-test.sh {submodule} {module} {backend}',
              timeout_seconds: 42,
            },
          },
        ],
      },
    },
  };

  const tasks = expandSubmodulesConfig(config, 'linux-x64');
  assertEquals(tasks.map((task) => `${task.module_path}:${task.backend}`), [
    '.:wasm',
    '.:native',
    'examples/foo:wasm',
  ]);

  const windowsTasks = expandSubmodulesConfig(config, 'windows-x64');
  assertEquals(windowsTasks.map((task) => `${task.module_path}:${task.backend}`), [
    '.:wasm',
    'examples/foo:wasm',
  ]);

  const windowsTasksWithExcluded = expandSubmodulesConfig(config, 'windows-x64', { includeExcluded: true });
  assertEquals(
    windowsTasksWithExcluded.map((task) => `${task.module_path}:${task.backend}:${task.excluded === true}`),
    [
      '.:wasm:false',
      '.:native:true',
      'examples/foo:wasm:false',
    ],
  );

  const native = tasks.find((task) => task.backend === 'native')!;
  assertEquals(native.submodule_path, 'deps/project');
  assertEquals(native.test.shell, './scripts/native-test.sh {submodule} {module} {backend}');
  assertEquals(native.test.timeout_seconds, 42);
  assertEquals(native.test.env, { NATIVE_ONLY: '1', BASE: '1' });

  const expanded = expandCommand(native.test, {
    backend: native.backend,
    os: native.os,
    submodule: native.submodule_path,
    module: native.module_path,
    working_directory: native.test.working_directory,
  });
  assertEquals(expanded, './scripts/native-test.sh deps/project . native');
});
