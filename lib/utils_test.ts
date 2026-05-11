import { executeWithExclusiveConcurrency } from './utils.ts';

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Assertion failed:\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test('executeWithExclusiveConcurrency runs exclusive tasks without overlap', async () => {
  const active = new Set<string>();
  const exclusiveNames = new Set(['heavy-a', 'heavy-b']);
  const starts: string[] = [];
  const violations: string[] = [];
  let maxActiveNormal = 0;

  function makeTask(name: string, ms: number) {
    const exclusive = exclusiveNames.has(name);
    return {
      exclusive,
      run: async () => {
        starts.push(name);

        if (exclusive && active.size > 0) {
          violations.push(`${name} started while ${Array.from(active).join(',')} was active`);
        }
        if (!exclusive && Array.from(active).some((activeName) => exclusiveNames.has(activeName))) {
          violations.push(`${name} started while an exclusive task was active`);
        }

        active.add(name);
        const activeNormalCount = Array.from(active).filter((activeName) => !exclusiveNames.has(activeName)).length;
        maxActiveNormal = Math.max(maxActiveNormal, activeNormalCount);
        await delay(ms);
        active.delete(name);
        return name;
      },
    };
  }

  const results = await executeWithExclusiveConcurrency([
    makeTask('normal-a', 20),
    makeTask('normal-b', 20),
    makeTask('heavy-a', 5),
    makeTask('normal-c', 5),
    makeTask('heavy-b', 5),
  ], 3);

  assertEquals(results, ['normal-a', 'normal-b', 'heavy-a', 'normal-c', 'heavy-b']);
  assertEquals(starts, ['normal-a', 'normal-b', 'heavy-a', 'normal-c', 'heavy-b']);
  assertEquals(violations, []);
  assertEquals(maxActiveNormal > 1, true);
});
