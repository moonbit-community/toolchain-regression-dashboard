import { parseArgs } from '@std/cli/parse-args';
import { join } from '@std/path/join';
import z from 'zod';
import { toolchainStat, writeToolchainJsonl } from './lib/toolchain_stat.ts';
import { SubmodulesConfigSchema, ToolchainOS, ToolchainOSSchema } from './lib/toolchain_types.ts';

type Cli =
  | {
    subcommand: 'stat';
    options: { config?: string; outDir?: string; os?: ToolchainOS; maxConcurrentSubmodules?: number };
  }
  | { subcommand: 'schema' };

function showHelp() {
  console.log(`
Toolchain Regression Dashboard

USAGE:
    deno run -A main.ts <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    stat             Run MoonBit test collection from resources/submodules.yaml
    schema           Generate resources/submodules.schema.json

GLOBAL OPTIONS:
    -h, --help       Show this help message
`);
}

function showStatHelp() {
  console.log(`
Run toolchain regression collection

USAGE:
    deno run -A main.ts stat [OPTIONS]

OPTIONS:
    --config <PATH>                         Path to submodules.yaml [default: resources/submodules.yaml]
    --out-dir <PATH>                        Output directory [default: data/toolchain/current/<os>]
    --os <OS>                               windows-x64, macos-arm64, or linux-x64 [default: auto]
    --max-concurrent-submodules <NUMBER>    Maximum concurrent submodules [default: 2]
    -h, --help                              Show this help message
`);
}

function parseToolchainOs(value: unknown): ToolchainOS | undefined {
  if (value === undefined) return undefined;
  const parsed = ToolchainOSSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid --os value: ${String(value)}. Expected windows-x64, macos-arm64, or linux-x64.`);
  }
  return parsed.data;
}

function parseStatArgs(args: string[]): Cli {
  const parsed = parseArgs(args, {
    string: ['config', 'out-dir', 'os', 'max-concurrent-submodules'],
    boolean: ['help'],
    alias: { h: 'help' },
  });

  if (parsed.help) {
    showStatHelp();
    Deno.exit(0);
  }

  return {
    subcommand: 'stat',
    options: {
      config: parsed.config,
      outDir: parsed['out-dir'],
      os: parseToolchainOs(parsed.os),
      maxConcurrentSubmodules: parsed['max-concurrent-submodules']
        ? parseInt(parsed['max-concurrent-submodules'], 10)
        : undefined,
    },
  };
}

function parseCli(args: string[]): Cli {
  const parsed = parseArgs(args, {
    boolean: ['help'],
    alias: { h: 'help' },
    stopEarly: true,
  });

  if (parsed.help) {
    showHelp();
    Deno.exit(0);
  }

  const subcommand = parsed._[0]?.toString();
  const rest = parsed._.slice(1).map(String);
  switch (subcommand) {
    case 'stat':
      return parseStatArgs(rest);
    case 'schema':
      return { subcommand: 'schema' };
    default:
      throw new Error(subcommand ? `Unknown subcommand: ${subcommand}` : 'No subcommand specified.');
  }
}

try {
  const cli = parseCli(Deno.args);

  if (cli.subcommand === 'stat') {
    const dashboard = await toolchainStat(cli.options);
    const path = join(dashboard.outDir, 'data.jsonl');
    await writeToolchainJsonl(path, dashboard.metadata, dashboard.result);
    console.log(`Wrote ${dashboard.result.length} toolchain records to ${path}`);
  } else if (cli.subcommand === 'schema') {
    await Deno.mkdir('resources', { recursive: true });
    await Deno.writeTextFile(
      'resources/submodules.schema.json',
      `${JSON.stringify(z.toJSONSchema(SubmodulesConfigSchema), null, 2)}\n`,
    );
    console.log('Generated resources/submodules.schema.json');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}
