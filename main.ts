import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
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
    node --import tsx main.ts <SUBCOMMAND> [OPTIONS]

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
    node --import tsx main.ts stat [OPTIONS]

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
  const { values: parsed } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      'out-dir': { type: 'string' },
      os: { type: 'string' },
      'max-concurrent-submodules': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (parsed.help) {
    showStatHelp();
    process.exit(0);
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
  if (args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const [subcommand, ...rest] = args;
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
  const cli = parseCli(process.argv.slice(2));

  if (cli.subcommand === 'stat') {
    const dashboard = await toolchainStat(cli.options);
    const path = join(dashboard.outDir, 'data.jsonl');
    await writeToolchainJsonl(path, dashboard.metadata, dashboard.result);
    console.log(`Wrote ${dashboard.result.length} toolchain records to ${path}`);
  } else if (cli.subcommand === 'schema') {
    await mkdir('resources', { recursive: true });
    await writeFile(
      'resources/submodules.schema.json',
      `${JSON.stringify(z.toJSONSchema(SubmodulesConfigSchema), null, 2)}\n`,
    );
    console.log('Generated resources/submodules.schema.json');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
