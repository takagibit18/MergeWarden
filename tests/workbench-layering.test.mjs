import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
async function sources(directory) {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
async function imports(file) {
  const text = await readFile(join(root, file), 'utf8');
  return [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]);
}
const resolved = (file, specifier) => relative(root, join(root, file, '..', specifier)).split(sep).join('/');

test('workbench application depends on ports, never on workbench storage implementations', async () => {
  for (const file of await sources('application/workbench')) {
    for (const specifier of await imports(file)) {
      const target = resolved(file, specifier);
      assert.ok(!/^infrastructure\/workbench-|^infrastructure\/workbench-storage|^composition\//.test(target), `${file} imports ${target}`);
    }
  }
});

test('infrastructure never depends on the application layer', async () => {
  for (const file of await sources('infrastructure')) {
    for (const specifier of await imports(file)) {
      const target = resolved(file, specifier);
      assert.ok(!target.startsWith('application/') && !target.startsWith('composition/'), `${file} imports ${target}`);
    }
  }
});
