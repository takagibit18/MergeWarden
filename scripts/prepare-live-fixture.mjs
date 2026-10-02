import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/prepare-live-fixture.mjs OUTPUT_DIRECTORY (must not exist)');
const directory = resolve(output);
// Exclusive directory admission: never modify an existing checkout.
await mkdir(directory);
const fixture = JSON.parse(await readFile(new URL('../fixtures/live-v01/fixture.json', import.meta.url), 'utf8'));
const exec = promisify(execFile);
const git = async (...args) => (await exec('git', ['-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-c','core.autocrlf=false','-c','user.name=MergeWarden fixture','-c','user.email=fixture@example.invalid','-C',directory,...args],{windowsHide:true})).stdout.trim();
await git('init','--initial-branch=main');
const commits = {};
for (const version of ['base','bug','fixed']) {
  for (const [path, source] of Object.entries(fixture.versions[version])) await writeFile(join(directory,path),source,'utf8');
  await git('add','.'); await git('commit','-m',`Frozen acceptance fixture: ${version}`); commits[version]=await git('rev-parse','HEAD');
}
console.log(JSON.stringify({ repository:directory, commits, expected:fixture.expected, note:'Fixture creation only. No model was called and no acceptance result is implied.' },null,2));
