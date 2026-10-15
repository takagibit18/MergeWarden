import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const packages = ['', 'integrations/pi', 'integrations/tree-sitter', 'integrations/mcp'];
const help = `MergeWarden Codex plugin (Node.js 22.19+, Git and npm)
node --experimental-strip-types scripts/codex-plugin.mjs COMMAND
  setup --repo ABSOLUTE_PATH --provider NAME --model ID --auth oauth
  setup --repo ABSOLUTE_PATH --provider NAME --model ID --api-key-env MERGEWARDEN_API_KEY
  prepare                         Install missing locked dependencies; no lifecycle scripts
  models [--provider NAME]         Read Pi's model catalog (not account entitlements)
  login                           Explicit Pi OAuth login for the saved profile
  doctor                          Check paths, dependencies and credential presence
  mcp                             Start the fixed-profile STDIO server; never installs packages
Setup options: --state OUTSIDE_PATH --thinking LEVEL --max-output-tokens N --skills auto|off
Profile: MERGEWARDEN_PLUGIN_CONFIG, or LOCALAPPDATA/MergeWarden2/plugin.json (home on Unix).
State defaults to LOCALAPPDATA/MergeWarden2. Profile stores only an API-key variable name.
After setup or a profile change, restart the Codex session/server. Run login separately for OAuth.`;

export class ConfigurationError extends Error {}
const invalid = message => { throw new ConfigurationError(message); };
export function profilePath(env = process.env) {
  const path = env.MERGEWARDEN_PLUGIN_CONFIG ?? join(env.LOCALAPPDATA ?? homedir(), 'MergeWarden2', 'plugin.json');
  if (!isAbsolute(path)) invalid('MERGEWARDEN_PLUGIN_CONFIG must be an absolute path.');
  return resolve(path);
}
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) invalid('Use Node.js 22.19 or newer.');
}
export function parseOptions(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.includes(key) || Object.hasOwn(result, key) || !value || value.startsWith('--')) invalid('Invalid, duplicate or incomplete option. Run help.');
    result[key] = value;
  }
  return result;
}
export function validateProfile(profile) {
  const keys = ['schemaVersion', 'repository', 'state', 'provider', 'model', 'authentication', 'apiKeyEnv', 'thinking', 'maxOutputTokens', 'skills'];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some(key => !keys.includes(key)) || profile.schemaVersion !== 1) invalid('Invalid plugin profile schema. Rerun setup.');
  for (const key of ['repository', 'state', 'provider', 'model']) {
    if (typeof profile[key] !== 'string' || !profile[key].trim() || /[\x00-\x1f]/.test(profile[key])) invalid(`Invalid profile field: ${key}.`);
  }
  if (!isAbsolute(profile.repository) || !isAbsolute(profile.state)) invalid('Repository and state must be absolute paths.');
  if (!['oauth', 'api-key'].includes(profile.authentication)) invalid('Select oauth or api-key authentication.');
  if (profile.authentication === 'oauth' && profile.apiKeyEnv !== undefined) invalid('OAuth and API-key authentication are mutually exclusive.');
  if (profile.authentication === 'api-key' && (typeof profile.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv))) invalid('API-key profiles require an environment variable name, not a secret.');
  if (profile.authentication === 'api-key' && profile.apiKeyEnv !== 'MERGEWARDEN_API_KEY') invalid('The Codex plugin forwards MERGEWARDEN_API_KEY. Use that environment variable, or configure the standalone MCP for a custom variable.');
  if (profile.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(profile.thinking)) invalid('Invalid thinking level.');
  if (profile.maxOutputTokens !== undefined && (!Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0)) invalid('Output token budget must be a positive integer.');
  if (profile.skills !== undefined && !['auto', 'off'].includes(profile.skills)) invalid('Skills must be auto or off.');
  return profile;
}
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function dependencyIssues(root = pluginRoot) {
  const issues = [];
  for (const directory of packages) {
    const base = join(root, directory);
    const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      try {
        const installed = JSON.parse(await readFile(join(base, 'node_modules', name, 'package.json'), 'utf8'));
        if (installed.version !== version) issues.push(`${directory || 'root'}:${name}`);
      } catch (e) { if (e.code !== 'ENOENT') throw e; issues.push(`${directory || 'root'}:${name}`); }
    }
  }
  if (!await exists(join(root, 'integrations/tree-sitter/node_modules/tree-sitter-python/tree-sitter-python.wasm'))) issues.push('python-grammar');
  return issues;
}
async function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'));
    try { candidates.push(join(dirname(await realpath(join(directory, 'npm'))), 'npm-cli.js')); } catch { /* Try the next installed npm path. */ }
  }
  for (const candidate of candidates) if (candidate?.endsWith('npm-cli.js') && await exists(candidate)) return candidate;
  invalid('npm CLI is unavailable. Install Node.js with npm, then rerun prepare.');
}
async function run(command, args, options = {}) {
  return await new Promise((accept, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: 'inherit', ...options });
    const interrupt = signal => { if (!child.killed) child.kill(signal); };
    const stop = () => interrupt('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.once('error', error => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); reject(error); });
    child.once('exit', code => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); accept(code ?? 2); });
  });
}
export async function prepare(root = pluginRoot) {
  checkNode();
  if (!(await dependencyIssues(root)).length) return;
  const npm = await npmCli();
  for (const directory of packages) {
    console.error(`MergeWarden: installing locked dependencies in ${directory || 'root'}.`);
    const code = await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev'], { cwd: join(root, directory), stdio: ['inherit', 'inherit', 'inherit'] });
    if (code !== 0) invalid('Dependency setup failed. Fix npm/network access, then rerun prepare.');
  }
  if ((await dependencyIssues(root)).length) invalid('Dependency setup did not produce the required locked packages.');
}
async function admit(profile, path) {
  validateProfile(profile);
  const { isolatedState } = await import('../src/infrastructure/files.ts');
  const repository = await realpath(profile.repository);
  // Git's per-command exception is restricted to the checkout explicitly selected by the user.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const git = await promisify(execFile)('git', ['-c', `safe.directory=${repository}`, '-C', repository, 'rev-parse', '--show-toplevel'], { windowsHide: true });
  if (await realpath(git.stdout.trim()) !== repository) invalid('--repo must be the Git checkout root.');
  profile = { ...profile, repository, state: await isolatedState(profile.state, repository) };
  const parent = await isolatedState(dirname(path), repository);
  const admittedPath = join(parent, path.slice(dirname(path).length + 1));
  if (await exists(admittedPath) && (await lstat(admittedPath)).isSymbolicLink()) invalid('The plugin profile must be a regular file, not a symlink.');
  return { profile, path: admittedPath };
}
export async function loadProfile(path = profilePath()) {
  try {
    if ((await lstat(path)).isSymbolicLink()) invalid('The plugin profile must be a regular file, not a symlink.');
    return (await admit(JSON.parse(await readFile(path, 'utf8')), path)).profile;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    invalid('Plugin profile unavailable or unsafe. Run setup with repository and state paths outside each other.');
  }
}
export async function configure(options, path = profilePath(), persist = true) {
  if (options.auth && options['api-key-env']) invalid('OAuth and API-key authentication are mutually exclusive.');
  const profile = validateProfile({ schemaVersion: 1,
    repository: options.repo, state: options.state ?? join(process.env.LOCALAPPDATA ?? homedir(), 'MergeWarden2'),
    provider: options.provider, model: options.model, authentication: options.auth ?? 'api-key',
    ...(options['api-key-env'] ? { apiKeyEnv: options['api-key-env'] } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options['max-output-tokens'] ? { maxOutputTokens: Number(options['max-output-tokens']) } : {}), skills: options.skills ?? 'auto' });
  const admitted = await admit(profile, path);
  const { writeJson } = await import('../src/infrastructure/files.ts');
  if (persist) await writeJson(admitted.path, admitted.profile);
  return { config: admitted.path, ...admitted.profile };
}
export function serverArgs(profile, root = pluginRoot) {
  validateProfile(profile);
  return ['--experimental-strip-types', join(root, 'integrations/mcp/src/main.ts'), '--repo', profile.repository, '--state', profile.state,
    '--provider', profile.provider, '--model', profile.model, ...(profile.authentication === 'oauth' ? ['--auth', 'oauth'] : ['--api-key-env', profile.apiKeyEnv]),
    ...(profile.thinking ? ['--thinking', profile.thinking] : []), ...(profile.maxOutputTokens ? ['--max-output-tokens', String(profile.maxOutputTokens)] : []),
    '--skills', profile.skills ?? 'auto'];
}
export function repositoryEnv(repository, env = process.env) {
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) invalid('Invalid inherited Git configuration count.');
  return { ...env, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'safe.directory', [`GIT_CONFIG_VALUE_${count}`]: repository };
}
export async function main(argv = process.argv.slice(2)) {
  checkNode();
  const command = argv[0] ?? 'help';
  if (command === 'help' || command === '--help') { console.log(help); return 0; }
  if (command === 'prepare') { if (argv.length !== 1) invalid('prepare accepts no arguments.'); await prepare(); return 0; }
  if (command === 'models') {
    const options = parseOptions(argv.slice(1), ['provider']); await prepare();
    return run(process.execPath, ['--experimental-strip-types', join(pluginRoot, 'src/cli/main.ts'), 'models', ...(options.provider ? ['--provider', options.provider] : [])]);
  }
  if (command === 'setup') {
    const options = parseOptions(argv.slice(1), ['repo', 'state', 'provider', 'model', 'auth', 'api-key-env', 'thinking', 'max-output-tokens', 'skills']);
    // Validate admission before downloading packages or replacing an existing profile.
    const result = await configure(options, profilePath(), false); await prepare();
    const { config, ...profile } = result;
    const { writeJson } = await import('../src/infrastructure/files.ts'); await writeJson(config, profile);
    console.log(JSON.stringify({ ...result, restartRequired: true }, null, 2)); return 0;
  }
  if (!['doctor', 'login', 'mcp'].includes(command) || argv.length !== 1) invalid('Unknown command or extra arguments. Run help.');
  const profile = await loadProfile();
  const missing = await dependencyIssues();
  if (command === 'doctor') {
    console.log(JSON.stringify({ node: process.version, pluginRoot, config: profilePath(), repository: profile.repository, state: profile.state,
      provider: profile.provider, model: profile.model, dependenciesReady: !missing.length, missing,
      authentication: profile.authentication, credentialPresent: profile.authentication === 'oauth' ? await exists(join(profile.state, 'auth/auth.json')) : !!process.env[profile.apiKeyEnv]?.trim(),
      credentialPresenceDoesNotProveModelAccess: true }, null, 2)); return missing.length ? 2 : 0;
  }
  if (missing.length) invalid('Plugin dependencies are not prepared. Run node --experimental-strip-types scripts/codex-plugin.mjs prepare in the installed plugin root.');
  const env = repositoryEnv(profile.repository);
  if (command === 'login') {
    if (profile.authentication !== 'oauth') invalid('This profile uses an API-key environment variable; OAuth login is not applicable.');
    return run(process.execPath, ['--experimental-strip-types', join(pluginRoot, 'src/cli/main.ts'), 'login', '--repo', profile.repository, '--state', profile.state, '--provider', profile.provider], { env });
  }
  return run(process.execPath, serverArgs(profile), { env });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(); }
  catch (error) {
    // Arbitrary npm/provider/Git/file errors can contain sensitive values; only our fixed messages are public.
    console.error(JSON.stringify({ error: error instanceof ConfigurationError ? error.message : 'MergeWarden plugin setup/startup failed. Check paths, dependencies and permissions. Credential details are not printed.' }));
    process.exitCode = 2;
  }
}
