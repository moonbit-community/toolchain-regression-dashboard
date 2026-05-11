export class MoonOpsError extends Error {
  constructor(public cmd: string, public originalError: Error) {
    super(`Moon operations error: ${cmd} - ${originalError.message}`);
    this.name = 'MoonOpsError';
  }
}

export async function getMoonVersion(): Promise<string[]> {
  const cmd = 'moon version --all';
  try {
    const process = new Deno.Command('moon', { args: ['version', '--all'] });
    const { success, stdout, code, stderr } = await process.output();

    if (!success) {
      const message = new TextDecoder().decode(stderr).trim();
      throw new Error(`Command failed with exit code ${code}${message ? `: ${message}` : ''}`);
    }

    return new TextDecoder().decode(stdout).trim().split('\n').map((line) => line.trim());
  } catch (error) {
    throw new MoonOpsError(cmd, error as Error);
  }
}
