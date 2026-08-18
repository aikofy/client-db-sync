import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));

/** Walk relative `from './x.js'` imports starting at `embed.ts`. */
function collect(entry: string, seen = new Set<string>()): string[] {
  const abs = join(srcDir, entry);
  if (seen.has(abs)) return [];
  seen.add(abs);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const files = [abs];
  for (const m of text.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
    let rel = m[1].replace(/^\.\//, '');
    if (rel.endsWith('.js')) rel = rel.slice(0, -3) + '.ts';
    else if (!rel.endsWith('.ts')) rel += '.ts';
    files.push(...collect(rel, seen));
  }
  return files;
}

describe('@aikofy/client-db-sync/embed module graph', () => {
  it('does not import fastify or @fastify/*', () => {
    const files = collect('embed.ts');
    expect(files.some((f) => f.endsWith('embed.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('server.ts'))).toBe(false);
    const joined = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(joined).not.toMatch(/from ['"]fastify['"]/);
    expect(joined).not.toMatch(/from ['"]@fastify\//);
    expect(joined).not.toMatch(/require\(['"]fastify['"]\)/);
    expect(joined).not.toMatch(/require\(['"]@fastify\//);
  });
});
