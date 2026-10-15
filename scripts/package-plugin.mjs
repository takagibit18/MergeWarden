import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { inside, isolatedState, sha256, writeJson } from '../src/infrastructure/files.ts';
const root = fileURLToPath(new URL('../', import.meta.url));

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Standard ZIP with UTF-8 paths, raw deflate and fixed timestamps; no platform archiver dependency.
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path), compressed = deflateRawSync(file.content), crc = crc32(file.content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x5021, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(0x5021, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(file.content.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function collect(path, result) {
  const info = await lstat(join(root, path));
  if (info.isSymbolicLink()) throw Error('Symlinks are not permitted in the plugin package.');
  if (info.isDirectory()) {
    for (const child of await readdir(join(root, path))) await collect(`${path}/${child}`, result);
  } else if (info.isFile()) result.add(path);
}

export async function packagePlugin(output) {
  const destination = await isolatedState(resolve(output), root);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  if (pkg.version !== manifest.version) throw Error('Package and plugin versions must match.');
  const paths = new Set(['package.json', 'README.md', 'LICENSE']);
  for (const path of pkg.files) await collect(path, paths);
  const files = [];
  for (const name of [...paths].sort()) {
    if (/(^|\/)(node_modules|\.git|\.env(?:\.[^/]*)?|auth\.json|plugin\.json\.[^/]*\.tmp|\.mergewarden)(\/|$)|\.(log|jsonl|tgz|zip)$/.test(name)) throw Error('Unexpected private/build file in plugin package.');
    const path = await realpath(join(root, name));
    if (!inside(await realpath(root), path)) throw Error('Package source escapes the repository.');
    const content = await readFile(path);
    files.push({ path: name, bytes: content.length, sha256: sha256(content), content });
  }
  for (const required of ['.codex-plugin/plugin.json', '.mcp.json', '.agents/plugins/marketplace.json', 'skills/mergewarden-review/SKILL.md',
    'scripts/codex-plugin.mjs', 'package-lock.json', 'integrations/pi/package-lock.json', 'integrations/pi/src/models.json',
    'integrations/tree-sitter/package-lock.json', 'integrations/tree-sitter/grammars/python.lock.json',
    'integrations/mcp/package-lock.json', 'integrations/mcp/src/main.ts', 'schemas/graph.sql']) {
    if (!files.some(file => file.path === required)) throw Error(`Package is missing ${required}`);
  }
  const archive = join(destination, `mergewarden-codex-plugin-${manifest.version}.zip`);
  const data = zip(files); await writeFile(archive, data);
  const result = { schemaVersion: 1, name: manifest.name, version: manifest.version, archive, bytes: data.length,
    sha256: sha256(data), files: files.map(({ content, ...entry }) => entry) };
  await writeJson(join(destination, 'package-manifest.json'), result);
  return { archive, manifest: join(destination, 'package-manifest.json'), files: files.length, bytes: result.bytes, sha256: result.sha256 };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') throw Error('Use npm run package:plugin -- --out /absolute/directory/outside/MergeWarden');
  console.log(JSON.stringify(await packagePlugin(process.argv[3]), null, 2));
}
