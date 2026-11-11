import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The simulation core must not depend on the UI, React or the DOM. */
describe('core purity', () => {
  const dir = join(__dirname, '..', 'src', 'core');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it.each(files)('%s imports only from the core', (f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    const imports = [...src.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const spec of imports) expect(spec, `${f} imports ${spec}`).toMatch(/^\.\/[\w-]+$/);
    expect(src).not.toMatch(/\b(window|document|localStorage)\./);
  });
});
