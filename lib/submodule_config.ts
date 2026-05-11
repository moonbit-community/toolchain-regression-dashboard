import * as yaml from '@std/yaml';
import {
  CommandSpec,
  EffectiveCommandSpec,
  ExpandedCommand,
  MatrixConfig,
  MatrixExclude,
  OverrideConfig,
  SubmoduleConfig,
  SubmodulesConfig,
  SubmodulesConfigSchema,
  ToolchainBackend,
  toolchainBackends,
  ToolchainOS,
  toolchainOses,
  ToolchainTask,
} from './toolchain_types.ts';

type NormalizedMatrix = {
  os: ToolchainOS[];
  backends: ToolchainBackend[];
  exclude: MatrixExclude[];
};

export interface ExpandSubmodulesConfigOptions {
  includeExcluded?: boolean;
}

export interface CommandTemplateContext {
  backend: ToolchainBackend;
  os: ToolchainOS;
  submodule: string;
  module: string;
  working_directory: string;
}

export function getCurrentToolchainOS(): ToolchainOS {
  if (Deno.build.os === 'linux' && Deno.build.arch === 'x86_64') return 'linux-x64';
  if (Deno.build.os === 'windows' && Deno.build.arch === 'x86_64') return 'windows-x64';
  if (Deno.build.os === 'darwin' && Deno.build.arch === 'aarch64') return 'macos-arm64';

  throw new Error(`Unsupported toolchain regression OS/arch: ${Deno.build.os}/${Deno.build.arch}`);
}

export function normalizeWorkspaceRelativePath(path: string | undefined, label = 'path'): string {
  const raw = (path ?? '.').trim().replaceAll('\\', '/');
  if (raw.length === 0) return '.';
  if (raw.includes('://') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`${label} must be a workspace-relative path: ${path}`);
  }

  const parts = raw.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new Error(`${label} must not contain '..': ${path}`);
  }

  return parts.length === 0 ? '.' : parts.join('/');
}

function mergeMatrix(base: NormalizedMatrix, override?: MatrixConfig): NormalizedMatrix {
  return {
    os: override?.os ? [...override.os] : [...base.os],
    backends: override?.backends ? [...override.backends] : [...base.backends],
    exclude: [...base.exclude, ...(override?.exclude ?? [])],
  };
}

function normalizeMatrix(config: MatrixConfig): NormalizedMatrix {
  return {
    os: config.os ? [...config.os] : [...toolchainOses],
    backends: config.backends ? [...config.backends] : [...toolchainBackends],
    exclude: [...(config.exclude ?? [])],
  };
}

function cloneCommandSpec(spec: CommandSpec): CommandSpec {
  const cloned = { ...spec };

  if (spec.argv !== undefined) {
    cloned.argv = [...spec.argv];
  } else {
    delete cloned.argv;
  }

  if (spec.env !== undefined) {
    cloned.env = { ...spec.env };
  } else {
    delete cloned.env;
  }

  return cloned;
}

function mergeCommandSpec(base: CommandSpec, override?: CommandSpec): CommandSpec {
  if (!override) return cloneCommandSpec(base);

  const merged: CommandSpec = {
    ...cloneCommandSpec(base),
    ...cloneCommandSpec(override),
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
  };

  if (Object.keys(merged.env ?? {}).length === 0) {
    delete merged.env;
  }

  if (override.argv !== undefined) {
    delete merged.shell;
  } else if (override.shell !== undefined) {
    delete merged.argv;
  }

  return merged;
}

function isExcluded(os: ToolchainOS, backend: ToolchainBackend, excludes: MatrixExclude[]): boolean {
  return excludes.some((exclude) => {
    const osMatches = exclude.os === undefined || exclude.os === os;
    const backendMatches = exclude.backend === undefined || exclude.backend === backend;
    return osMatches && backendMatches;
  });
}

function matchesOverride(override: OverrideConfig, os: ToolchainOS, backend: ToolchainBackend): boolean {
  const osMatches = override.match.os === undefined || override.match.os.includes(os);
  const backendMatches = override.match.backends === undefined || override.match.backends.includes(backend);
  return osMatches && backendMatches;
}

function materializeCommand(
  spec: CommandSpec,
  defaultWorkingDirectory: string,
  overrideEnv: Record<string, string>,
): EffectiveCommandSpec {
  const forms = [spec.argv !== undefined, spec.shell !== undefined].filter(Boolean).length;
  if (forms !== 1) {
    throw new Error('Effective test command must set exactly one of argv or shell.');
  }

  if (spec.argv && spec.argv.length === 0) {
    throw new Error('Effective test command argv must not be empty.');
  }

  return {
    argv: spec.argv ? [...spec.argv] : undefined,
    shell: spec.shell,
    timeout_seconds: spec.timeout_seconds,
    env: {
      ...overrideEnv,
      ...(spec.env ?? {}),
    },
    working_directory: normalizeWorkspaceRelativePath(
      spec.working_directory ?? defaultWorkingDirectory,
      'working_directory',
    ),
  };
}

export function expandTemplate(value: string, context: CommandTemplateContext): string {
  return value.replaceAll(
    /\{(backend|os|submodule|module|working_directory)\}/g,
    (_match, key: keyof CommandTemplateContext) => context[key],
  );
}

export function expandCommand(
  command: EffectiveCommandSpec,
  context: CommandTemplateContext,
): ExpandedCommand | undefined {
  if (command.argv) return command.argv.map((arg) => expandTemplate(arg, context));
  if (command.shell) return expandTemplate(command.shell, context);
  return undefined;
}

export function expandSubmodulesConfig(
  config: SubmodulesConfig,
  targetOs?: ToolchainOS,
  options: ExpandSubmodulesConfigOptions = {},
): ToolchainTask[] {
  const defaultsMatrix = normalizeMatrix(config.defaults.matrix);
  const defaultsTest = cloneCommandSpec(config.defaults.test);
  const tasks: ToolchainTask[] = [];

  for (const [submodulePath, submoduleConfig] of Object.entries(config.submodules)) {
    const normalizedSubmodulePath = normalizeWorkspaceRelativePath(submodulePath, 'submodule path');
    const submoduleMatrix = mergeMatrix(defaultsMatrix, submoduleConfig.matrix);
    const submoduleTest = mergeCommandSpec(defaultsTest, submoduleConfig.test);
    const moduleConfigs = getModuleConfigs(submoduleConfig);

    for (const moduleConfig of moduleConfigs) {
      const modulePath = normalizeWorkspaceRelativePath(moduleConfig.path, 'module path');
      const matrix = mergeMatrix(submoduleMatrix, moduleConfig.matrix);
      const moduleTest = mergeCommandSpec(submoduleTest, moduleConfig.test);
      const overrides = [...(submoduleConfig.overrides ?? []), ...(moduleConfig.overrides ?? [])];

      for (const os of matrix.os) {
        if (targetOs !== undefined && os !== targetOs) continue;

        for (const backend of matrix.backends) {
          const excluded = isExcluded(os, backend, matrix.exclude);
          if (excluded && !options.includeExcluded) continue;

          let test = mergeCommandSpec(moduleTest);
          let defaultWorkingDirectory = modulePath;
          const overrideEnv: Record<string, string> = {};

          for (const override of overrides) {
            if (!matchesOverride(override, os, backend)) continue;

            if (override.working_directory !== undefined) {
              defaultWorkingDirectory = normalizeWorkspaceRelativePath(override.working_directory, 'working_directory');
            }
            Object.assign(overrideEnv, override.env ?? {});
            test = mergeCommandSpec(test, override.test);
          }

          tasks.push({
            submodule_path: normalizedSubmodulePath,
            resource_intensive: submoduleConfig.resource_intensive === true,
            module_path: modulePath,
            os,
            backend,
            excluded: excluded ? true : undefined,
            test: materializeCommand(test, defaultWorkingDirectory, overrideEnv),
          });
        }
      }
    }
  }

  return tasks;
}

function getModuleConfigs(
  submoduleConfig: SubmoduleConfig,
): Array<{ path: string; matrix?: MatrixConfig; test?: CommandSpec; overrides?: OverrideConfig[] }> {
  if (submoduleConfig.modules && submoduleConfig.modules.length > 0) {
    return submoduleConfig.modules;
  }

  return [{
    path: normalizeWorkspaceRelativePath(submoduleConfig.working_directory, 'working_directory'),
  }];
}

export async function loadSubmodulesConfig(filePath: string): Promise<SubmodulesConfig> {
  const content = await Deno.readTextFile(filePath);
  const parsed = SubmodulesConfigSchema.parse(yaml.parse(content));
  const submodules: Record<string, SubmoduleConfig> = {};

  for (const [path, submodule] of Object.entries(parsed.submodules)) {
    const normalized = normalizeWorkspaceRelativePath(path, 'submodule path');
    if (submodules[normalized]) {
      throw new Error(`Duplicate submodule path after normalization: ${normalized}`);
    }
    submodules[normalized] = submodule;
  }

  return { ...parsed, submodules };
}
