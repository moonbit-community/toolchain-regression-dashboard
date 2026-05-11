import { JsonStringifyStream } from '@std/json';
import { dirname } from '@std/path/dirname';
import { join } from '@std/path/join';
import {
  expandCommand,
  expandSubmodulesConfig,
  getCurrentToolchainOS,
  loadSubmodulesConfig,
} from './submodule_config.ts';
import {
  EffectiveCommandSpec,
  ExpandedCommand,
  ToolchainMetadata,
  ToolchainOS,
  ToolchainResultRecord,
  ToolchainTask,
} from './toolchain_types.ts';
import { sha256Hex } from './log.ts';
import { getMoonVersion } from './moon.ts';
import { executeWithExclusiveConcurrency } from './utils.ts';

const DEFAULT_MAX_CONCURRENT_SUBMODULES = 2;
const DEFAULT_TEST_TIMEOUT_SECONDS = 1200;
const MOON_ENV = {
  MOON_IGNORE_PREBUILD: '1',
  MOON_NO_WORKSPACE: '1',
} as const;

export interface ToolchainStatOptions {
  config?: string;
  outDir?: string;
  os?: ToolchainOS;
  maxConcurrentSubmodules?: number;
  workspaceRoot?: string;
}

interface ProcessResult {
  success: boolean;
  exit_code?: number;
  elapsed: number;
  reason?: string;
}

export function groupTasksBySubmodule(tasks: ToolchainTask[]): ToolchainTask[][] {
  const groups = new Map<string, ToolchainTask[]>();
  for (const task of tasks) {
    const group = groups.get(task.submodule_path) ?? [];
    group.push(task);
    groups.set(task.submodule_path, group);
  }
  return Array.from(groups.values());
}

function isResourceIntensiveGroup(tasks: ToolchainTask[]): boolean {
  return tasks.some((task) => task.resource_intensive === true);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const process = new Deno.Command('git', {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await process.output();
  const stdoutText = new TextDecoder().decode(stdout).trim();
  if (code !== 0) {
    const stderrText = new TextDecoder().decode(stderr).trim();
    throw new Error(`git ${args.join(' ')} failed with exit code ${code}${stderrText ? `: ${stderrText}` : ''}`);
  }
  return stdoutText;
}

async function readSubmoduleCommit(submoduleDir: string): Promise<string> {
  const stat = await Deno.stat(submoduleDir).catch(() => undefined);
  if (!stat?.isDirectory) {
    throw new Error(`Submodule path does not exist or is not a directory: ${submoduleDir}`);
  }
  return await runGit(['rev-parse', 'HEAD'], submoduleDir);
}

export async function makeLogPaths(
  dataDir: string,
  task: ToolchainTask,
): Promise<{ stdout_path: string; stderr_path: string }> {
  await Deno.mkdir(join(dataDir, 'logs'), { recursive: true });
  const hash = await sha256Hex([
    task.submodule_path,
    task.module_path,
    task.os,
    task.backend,
  ].join('|'));
  const prefix = hash.slice(0, 16);
  return {
    stdout_path: join(dataDir, 'logs', `${prefix}.stdout.log`),
    stderr_path: join(dataDir, 'logs', `${prefix}.stderr.log`),
  };
}

function commandContext(task: ToolchainTask, command: EffectiveCommandSpec) {
  return {
    backend: task.backend,
    os: task.os,
    submodule: task.submodule_path,
    module: task.module_path,
    working_directory: command.working_directory,
  };
}

function baseRecord(
  task: ToolchainTask,
  command: EffectiveCommandSpec,
  commitSha: string | undefined,
  expandedCommand: ExpandedCommand | undefined,
): Omit<ToolchainResultRecord, 'status'> {
  const env = Object.keys(command.env).length > 0 ? { env: { ...command.env } } : {};

  return {
    submodule_path: task.submodule_path,
    module_path: task.module_path,
    commit_sha: commitSha,
    os: task.os,
    backend: task.backend,
    working_directory: command.working_directory,
    expanded_command: expandedCommand,
    ...env,
  };
}

async function writeFailureLog(
  dataDir: string,
  task: ToolchainTask,
  message: string,
): Promise<{ stdout_path: string; stderr_path: string }> {
  const paths = await makeLogPaths(dataDir, task);
  await Deno.writeTextFile(paths.stdout_path, '');
  await Deno.writeTextFile(paths.stderr_path, message);
  return paths;
}

function shellCommandArgs(shell: string): { command: string; args: string[] } {
  if (Deno.build.os === 'windows') {
    return { command: 'cmd', args: ['/d', '/s', '/c', shell] };
  }

  return { command: 'sh', args: ['-c', shell] };
}

async function runExpandedCommand(
  expandedCommand: ExpandedCommand,
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  stdoutPath: string,
  stderrPath: string,
): Promise<ProcessResult> {
  const started = performance.now();
  const signal = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    signal.abort();
  }, timeoutSeconds * 1000);

  const command = Array.isArray(expandedCommand)
    ? { command: expandedCommand[0], args: expandedCommand.slice(1) }
    : shellCommandArgs(expandedCommand);

  try {
    using stdoutFile = await Deno.open(stdoutPath, { create: true, write: true, truncate: true });
    using stderrFile = await Deno.open(stderrPath, { create: true, write: true, truncate: true });
    const process = new Deno.Command(command.command, {
      args: command.args,
      cwd,
      env: { ...MOON_ENV, ...env },
      signal: signal.signal,
      stdout: 'piped',
      stderr: 'piped',
    });
    const child = process.spawn();
    const stdoutTask = child.stdout.pipeTo(stdoutFile.writable);
    const stderrTask = child.stderr.pipeTo(stderrFile.writable);

    try {
      const status = await child.status;
      await Promise.all([stdoutTask, stderrTask]);
      return {
        success: status.success,
        exit_code: status.code,
        elapsed: Math.round((performance.now() - started) / 10) / 100,
      };
    } catch (error) {
      await Promise.allSettled([stdoutTask, stderrTask]);
      return {
        success: false,
        elapsed: Math.round((performance.now() - started) / 10) / 100,
        reason: timedOut ? `Command timed out after ${timeoutSeconds} seconds.` : String(error),
      };
    }
  } catch (error) {
    await Deno.writeTextFile(stderrPath, error instanceof Error ? error.message : String(error)).catch(() => {});
    return {
      success: false,
      elapsed: Math.round((performance.now() - started) / 10) / 100,
      reason: timedOut ? `Command timed out after ${timeoutSeconds} seconds.` : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeTest(
  submoduleDir: string,
  dataDir: string,
  task: ToolchainTask,
  commitSha: string | undefined,
): Promise<ToolchainResultRecord> {
  const command = task.test;
  const expandedCommand = expandCommand(command, commandContext(task, command));
  const record = baseRecord(task, command, commitSha, expandedCommand);

  if (!expandedCommand) {
    return {
      ...record,
      status: 'Error',
      reason: 'No executable test command was resolved.',
    };
  }

  const paths = await makeLogPaths(dataDir, task);
  const startTime = new Date().toISOString();
  const result = await runExpandedCommand(
    expandedCommand,
    join(submoduleDir, command.working_directory),
    command.env,
    command.timeout_seconds ?? DEFAULT_TEST_TIMEOUT_SECONDS,
    paths.stdout_path,
    paths.stderr_path,
  );

  return {
    ...record,
    status: result.success ? 'Pass' : 'Error',
    start_time: startTime,
    elapsed: result.elapsed,
    exit_code: result.exit_code,
    stdout_path: paths.stdout_path,
    stderr_path: paths.stderr_path,
    reason: result.reason,
  };
}

function excludedRecord(task: ToolchainTask): ToolchainResultRecord {
  return {
    ...baseRecord(task, task.test, undefined, undefined),
    status: 'Excluded',
    reason: 'Excluded by matrix configuration.',
  };
}

async function commitFailureRecords(
  dataDir: string,
  tasks: ToolchainTask[],
  error: unknown,
): Promise<ToolchainResultRecord[]> {
  const message = error instanceof Error ? error.message : String(error);
  const records: ToolchainResultRecord[] = [];

  for (const task of tasks) {
    const expanded = expandCommand(task.test, commandContext(task, task.test));
    const paths = await writeFailureLog(dataDir, task, message);
    records.push({
      ...baseRecord(task, task.test, undefined, expanded),
      status: 'Error',
      stdout_path: paths.stdout_path,
      stderr_path: paths.stderr_path,
      reason: `Failed to read submodule commit: ${message}`,
    });
  }

  return records;
}

async function executeSubmoduleGroup(
  workspaceRoot: string,
  dataDir: string,
  tasks: ToolchainTask[],
): Promise<ToolchainResultRecord[]> {
  if (tasks.length === 0) return [];

  const submoduleDir = join(workspaceRoot, tasks[0].submodule_path);
  let commitSha: string;
  try {
    commitSha = await readSubmoduleCommit(submoduleDir);
  } catch (error) {
    return await commitFailureRecords(dataDir, tasks, error);
  }

  const records: ToolchainResultRecord[] = [];
  for (const task of tasks) {
    records.push(await executeTest(submoduleDir, dataDir, task, commitSha));
  }
  return records;
}

async function readToolchainVersion(): Promise<string[]> {
  try {
    return await getMoonVersion();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`unavailable: ${message}`];
  }
}

export async function toolchainStat(
  options: ToolchainStatOptions,
): Promise<{ metadata: ToolchainMetadata; result: ToolchainResultRecord[]; os: ToolchainOS; outDir: string }> {
  const os = options.os ?? getCurrentToolchainOS();
  const outDir = options.outDir ?? `data/toolchain/current/${os}`;
  const workspaceRoot = options.workspaceRoot ?? Deno.cwd();
  const config = await loadSubmodulesConfig(options.config ?? 'resources/submodules.yaml');
  const tasks = expandSubmodulesConfig(config, os, { includeExcluded: true });
  const executableTasks = tasks.filter((task) => !task.excluded);
  const excludedResult = tasks.filter((task) => task.excluded).map(excludedRecord);
  const groups = groupTasksBySubmodule(executableTasks);
  const maxConcurrentSubmodules = options.maxConcurrentSubmodules ??
    parseInt(Deno.env.get('MAX_CONCURRENT_SUBMODULES') ?? String(DEFAULT_MAX_CONCURRENT_SUBMODULES), 10);

  const groupedResults = await executeWithExclusiveConcurrency(
    groups.map((group) => ({
      exclusive: isResourceIntensiveGroup(group),
      run: () => executeSubmoduleGroup(workspaceRoot, outDir, group),
    })),
    maxConcurrentSubmodules,
  );

  return {
    os,
    outDir,
    metadata: {
      runId: Deno.env.get('GITHUB_ACTION_RUN_ID') || '0',
      runNumber: Deno.env.get('GITHUB_ACTION_RUN_NUMBER') || '0',
      generated_at: new Date().toISOString(),
      toolchainVersion: await readToolchainVersion(),
    },
    result: [...groupedResults.flat(), ...excludedResult],
  };
}

export async function writeToolchainJsonl(
  path: string,
  metadata: ToolchainMetadata,
  records: ToolchainResultRecord[],
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  using file = await Deno.open(path, {
    create: true,
    write: true,
    truncate: true,
  });
  await ReadableStream.from([metadata, ...records])
    .pipeThrough(new JsonStringifyStream())
    .pipeThrough(new TextEncoderStream())
    .pipeTo(file.writable);
}
