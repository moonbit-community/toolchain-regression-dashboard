import { z } from 'zod';

export const ToolchainOSSchema = z.enum(['windows-x64', 'macos-arm64', 'linux-x64']);
export type ToolchainOS = z.infer<typeof ToolchainOSSchema>;
export const toolchainOses = ['windows-x64', 'macos-arm64', 'linux-x64'] as const satisfies readonly ToolchainOS[];

export const ToolchainBackendSchema = z.enum(['wasm', 'wasm-gc', 'js', 'native']);
export type ToolchainBackend = z.infer<typeof ToolchainBackendSchema>;
export const toolchainBackends = ['wasm', 'wasm-gc', 'js', 'native'] as const satisfies readonly ToolchainBackend[];

export const ToolchainStatusSchema = z.enum(['Pass', 'Error', 'Excluded']);
export type ToolchainStatus = z.infer<typeof ToolchainStatusSchema>;

export const MatrixExcludeSchema = z.object({
  os: ToolchainOSSchema.optional(),
  backend: ToolchainBackendSchema.optional(),
}).strict();
export type MatrixExclude = z.infer<typeof MatrixExcludeSchema>;

export const MatrixConfigSchema = z.object({
  os: z.array(ToolchainOSSchema).optional(),
  backends: z.array(ToolchainBackendSchema).optional(),
  exclude: z.array(MatrixExcludeSchema).optional(),
}).strict();
export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

export const CommandSpecSchema = z.object({
  argv: z.array(z.string()).optional(),
  shell: z.string().optional(),
  timeout_seconds: z.number().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
  working_directory: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  const forms = [value.argv !== undefined, value.shell !== undefined].filter(Boolean).length;
  if (forms > 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'CommandSpec must not set both argv and shell.',
    });
  }
});
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const OverrideConfigSchema = z.object({
  match: z.object({
    os: z.array(ToolchainOSSchema).optional(),
    backends: z.array(ToolchainBackendSchema).optional(),
  }).strict().default({}),
  test: CommandSpecSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  working_directory: z.string().optional(),
}).strict();
export type OverrideConfig = z.infer<typeof OverrideConfigSchema>;

export const ModuleConfigSchema = z.object({
  path: z.string(),
  matrix: MatrixConfigSchema.optional(),
  test: CommandSpecSchema.optional(),
  overrides: z.array(OverrideConfigSchema).optional(),
}).strict();
export type ModuleConfig = z.infer<typeof ModuleConfigSchema>;

export const DefaultsSchema = z.object({
  matrix: MatrixConfigSchema,
  test: CommandSpecSchema,
}).strict();
export type DefaultsConfig = z.infer<typeof DefaultsSchema>;

export const SubmoduleConfigSchema = z.object({
  resource_intensive: z.boolean().optional(),
  working_directory: z.string().optional(),
  modules: z.array(ModuleConfigSchema).optional(),
  matrix: MatrixConfigSchema.optional(),
  test: CommandSpecSchema.optional(),
  overrides: z.array(OverrideConfigSchema).optional(),
}).strict();
export type SubmoduleConfig = z.infer<typeof SubmoduleConfigSchema>;

export const SubmodulesConfigSchema = z.object({
  schema_version: z.literal(1),
  defaults: DefaultsSchema,
  submodules: z.record(z.string(), SubmoduleConfigSchema),
}).strict();
export type SubmodulesConfig = z.infer<typeof SubmodulesConfigSchema>;

export type ExpandedCommand = string[] | string;

export interface EffectiveCommandSpec {
  argv?: string[];
  shell?: string;
  timeout_seconds?: number;
  env: Record<string, string>;
  working_directory: string;
}

export interface ToolchainTask {
  submodule_path: string;
  resource_intensive: boolean;
  module_path: string;
  os: ToolchainOS;
  backend: ToolchainBackend;
  excluded?: boolean;
  test: EffectiveCommandSpec;
}

export interface ToolchainMetadata {
  runId: string;
  runNumber: string;
  generated_at: string;
  toolchainVersion: string[];
}

export interface ToolchainResultRecord {
  submodule_path: string;
  module_path: string;
  commit_sha?: string;
  os: ToolchainOS;
  backend: ToolchainBackend;
  status: ToolchainStatus;
  start_time?: string;
  elapsed?: number;
  working_directory: string;
  expanded_command?: ExpandedCommand;
  env?: Record<string, string>;
  exit_code?: number;
  stdout_path?: string;
  stderr_path?: string;
  reason?: string;
}
