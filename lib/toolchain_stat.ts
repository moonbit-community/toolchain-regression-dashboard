import { appendFile, mkdir, open, writeFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { join } from 'node:path';
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
  const { stdout } = await promisify(execFile)('git', args, { cwd });
  return stdout.trim();
}

async function readSubmoduleCommit(submoduleDir: string): Promise<string> {
  const info = await stat(submoduleDir).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`Submodule path does not exist or is not a directory: ${submoduleDir}`);
  }
  return await runGit(['rev-parse', 'HEAD'], submoduleDir);
}

export async function makeLogPaths(
  dataDir: string,
  task: ToolchainTask,
): Promise<{ stdout_path: string; stderr_path: string }> {
  await mkdir(join(dataDir, 'logs'), { recursive: true });
  const hash = await sha256Hex([task.submodule_path, task.module_path, task.os, task.backend].join('|'));
  const prefix = hash.slice(0, 16);
  return {
    stdout_path: join(dataDir, 'logs', `${prefix}.stdout.log`).replaceAll('\\', '/'),
    stderr_path: join(dataDir, 'logs', `${prefix}.stderr.log`).replaceAll('\\', '/'),
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
  await writeFile(paths.stdout_path, '');
  await writeFile(paths.stderr_path, message);
  return paths;
}

function shellCommandArgs(shell: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
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
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const command = Array.isArray(expandedCommand)
    ? { command: expandedCommand[0], args: expandedCommand.slice(1) }
    : shellCommandArgs(expandedCommand);

  try {
    const stdoutFile = await open(stdoutPath, 'w');
    try {
      const stderrFile = await open(stderrPath, 'w');
      try {
        // Write directly to files so large compiler logs never fill an in-memory buffer.
        const child = spawn(command.command, command.args, {
          cwd,
          env: { ...process.env, ...MOON_ENV, ...env },
          stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
        const status = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        timeout = setTimeout(() => {
          timedOut = true;
          if (!child.pid) return;
          if (process.platform === 'win32') {
            // Terminate the compiler and its children, including shell commands.
            execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], (error) => {
              if (error) child.kill('SIGKILL');
            });
          } else {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
        }, timeoutSeconds * 1000);
        const { code, signal } = await status;
        return {
          success: !timedOut && code === 0,
          exit_code: code ?? undefined,
          elapsed: Math.round((performance.now() - started) / 10) / 100,
          reason: timedOut
            ? `Command timed out after ${timeoutSeconds} seconds.`
            : signal
              ? `Command terminated by ${signal}.`
              : undefined,
        };
      } finally {
        clearTimeout(timeout);
        await stderrFile.close();
      }
    } finally {
      await stdoutFile.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendFile(stderrPath, message).catch(() => undefined);
    return {
      success: false,
      elapsed: Math.round((performance.now() - started) / 10) / 100,
      reason: timedOut ? `Command timed out after ${timeoutSeconds} seconds.` : message,
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
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const config = await loadSubmodulesConfig(options.config ?? 'resources/submodules.yaml');
  const tasks = expandSubmodulesConfig(config, os, { includeExcluded: true });
  const executableTasks = tasks.filter((task) => !task.excluded);
  const excludedResult = tasks.filter((task) => task.excluded).map(excludedRecord);
  const groups = groupTasksBySubmodule(executableTasks);
  const maxConcurrentSubmodules =
    options.maxConcurrentSubmodules ??
    parseInt(process.env.MAX_CONCURRENT_SUBMODULES ?? String(DEFAULT_MAX_CONCURRENT_SUBMODULES), 10);

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
      runId: process.env.GITHUB_ACTION_RUN_ID || '0',
      runNumber: process.env.GITHUB_ACTION_RUN_NUMBER || '0',
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [metadata, ...records].map((value) => JSON.stringify(value)).join('\n') + '\n');
}
