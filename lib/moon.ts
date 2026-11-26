import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export class MoonOpsError extends Error {
  constructor(
    public cmd: string,
    public originalError: Error,
  ) {
    super(`Moon operations error: ${cmd} - ${originalError.message}`);
    this.name = 'MoonOpsError';
  }
}

export async function getMoonVersion(): Promise<string[]> {
  const cmd = 'moon version --all';
  try {
    const { stdout } = await promisify(execFile)('moon', ['version', '--all']);
    return stdout
      .trim()
      .split('\n')
      .map((line) => line.trim());
  } catch (error) {
    throw new MoonOpsError(cmd, error as Error);
  }
}
