import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, symlink } from 'node:fs/promises';
import { configure, loadProfile, parseOptions, profilePath, repositoryEnv, serverArgs, validateProfile } from '../scripts/codex-plugin.mjs';
import { repositoryFixture } from './repository-fixture.mjs';

test('plugin profile binds canonical checkout, model and environment variable without copying a key', async t => {
  const f = await repositoryFixture(t); const path = join(f.state, 'plugin.json');
  await configure({ repo: f.repository, state: f.state, provider: 'fixture', model: 'offline', 'api-key-env': 'MERGEWARDEN_API_KEY', thinking: 'low', 'max-output-tokens': '512', skills: 'off' }, path);
  const profile = await loadProfile(path);
  assert.equal(profile.repository, f.repository); assert.equal(profile.apiKeyEnv, 'MERGEWARDEN_API_KEY');
  assert.equal(profile.maxOutputTokens, 512); assert.equal(profile.authentication, 'api-key');
  const args = serverArgs(profile, '/plugin');
  assert.deepEqual(args.slice(-6), ['--thinking', 'low', '--max-output-tokens', '512', '--skills', 'off']);
  assert.ok(args.includes('MERGEWARDEN_API_KEY')); assert.ok(!args.includes(process.env.MERGEWARDEN_API_KEY ?? 'secret-not-in-args'));
  const env = repositoryEnv(profile.repository, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
  assert.equal(env.GIT_CONFIG_COUNT, '2'); assert.equal(env.GIT_CONFIG_KEY_1, 'safe.directory'); assert.equal(env.GIT_CONFIG_VALUE_1, f.repository);
  assert.equal(env.GIT_CONFIG_VALUE_0, 'false');
});

test('plugin configuration rejects checkout-local state/profile and preserves an existing profile', async t => {
  const f = await repositoryFixture(t); const path = join(f.state, 'plugin.json');
  const options = { repo: f.repository, state: f.state, provider: 'fixture', model: 'offline', auth: 'oauth' };
  await configure(options, path); const original = await readFile(path, 'utf8');
  await assert.rejects(configure({ ...options, state: join(f.repository, '.state') }, path), /outside and separate/);
  await assert.rejects(configure(options, join(f.repository, '.profile/plugin.json')), /outside and separate/);
  await assert.rejects(configure({ ...options, 'api-key-env': 'KEY' }, path), /mutually exclusive/);
  assert.equal(await readFile(path, 'utf8'), original);
  await configure({ ...options, model: 'different' }, path, false);
  assert.equal(await readFile(path, 'utf8'), original, 'preparation preflight cannot replace an existing profile');
});

test('plugin profile rejects unknown fields, secret values, relative paths and unsafe option syntax', () => {
  const valid = { schemaVersion: 1, repository: process.cwd(), state: join(process.cwd(), '..', 'state'), provider: 'fixture', model: 'offline', authentication: 'oauth' };
  assert.throws(() => validateProfile({ ...valid, apiKey: 'secret' }), /schema/);
  assert.throws(() => validateProfile({ ...valid, authentication: 'api-key', apiKeyEnv: 'sk-not-a-variable' }), /variable name/);
  assert.throws(() => validateProfile({ ...valid, authentication: 'api-key', apiKeyEnv: 'CUSTOM_API_KEY' }), /forwards MERGEWARDEN_API_KEY/);
  assert.throws(() => validateProfile({ ...valid, repository: './checkout' }), /absolute/);
  assert.throws(() => validateProfile({ ...valid, maxOutputTokens: NaN }), /positive integer/);
  assert.throws(() => profilePath({ MERGEWARDEN_PLUGIN_CONFIG: './profile.json' }), /absolute/);
  assert.throws(() => parseOptions(['--repo', '/first', '--repo', '/second'], ['repo']), /duplicate/);
  assert.throws(() => parseOptions(['--repo'], ['repo']), /incomplete/);
});

test('plugin refuses a symlink profile', async t => {
  const f = await repositoryFixture(t); const target = join(f.state, 'target.json'), path = join(f.state, 'plugin.json');
  const options = { repo: f.repository, state: f.state, provider: 'fixture', model: 'offline', auth: 'oauth' };
  await configure(options, target);
  try { await symlink(target, path); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows does not permit file symlinks for this test account'); return; } throw error; }
  await assert.rejects(configure(options, path), /symlink/); await assert.rejects(loadProfile(path), /symlink/);
});
