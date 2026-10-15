import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { encodeFindingId } from '@mergewarden/contracts';
import { WorkbenchError } from '../../../src/application/workbench/index.ts';
import { bootstrapHtml, scrubFragmentScript } from '../src/bootstrap.ts';
import { requestPath } from '../src/assets.ts';
import { parseLaunchOptions } from '../src/main.ts';
import { assertError, authenticate, fakeService, get, HOST, ITEM, ORIGIN, PROJECT, PROJECT_ID, REPORT, RUN_ID, serverFixture } from './helpers.mjs';

test('startup shell removes fragment before exchanging it and loads no resources', async t => {
  const { server, app } = await serverFixture(t);
  const response = await get(app, '/');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, bootstrapHtml);
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /script-src 'sha256-/);
  assert.ok(response.body.indexOf('history.replaceState') < response.body.indexOf('fetch('));
  assert.ok(!response.body.includes(server.launchToken));
  assert.ok(!response.body.includes('src='));
  assertError(await get(app, '/api/v1/config'), 401, 'UNAUTHORIZED');
});

test('bootstrap and API enforce actual Host, exact Origin and same-origin fetch metadata', async t => {
  const { server, app } = await serverFixture(t);
  assertError(await get(app, '/', undefined, { host: 'attacker.invalid:4242' }), 403, 'INVALID_HOST');
  assertError(await get(app, '/', undefined, { host: 'localhost:4242' }), 403, 'INVALID_HOST');
  assertError(await get(app, '/', undefined, { origin: 'https://attacker.invalid' }), 403, 'INVALID_ORIGIN');
  assertError(await get(app, '/', undefined, { 'sec-fetch-site': 'same-site' }), 403, 'INVALID_ORIGIN');
  assertError(await get(app, '/', undefined, { 'sec-fetch-site': 'cross-site' }), 403, 'INVALID_ORIGIN');
  assertError(await app.inject({ method: 'POST', url: '/_workbench/session', headers: { host: HOST }, payload: { token: server.launchToken } }), 403, 'INVALID_ORIGIN');
  const wrong = 'x'.repeat(43);
  const denied = await app.inject({ method: 'POST', url: '/_workbench/session', headers: { host: HOST, origin: ORIGIN }, payload: { token: wrong } });
  assertError(denied, 401, 'UNAUTHORIZED');
  assert.ok(!denied.body.includes(wrong));
  const cookie = await authenticate(server);
  assertError(await get(app, '/api/v1/config', cookie, { origin: 'http://127.0.0.1:4243' }), 403, 'INVALID_ORIGIN');
});

test('session cookie is HttpOnly, strict, process-local and usable by either browser', async t => {
  const first = await serverFixture(t), second = await serverFixture(t);
  const result = await first.app.inject({ method: 'POST', url: '/_workbench/session', headers: { host: HOST, origin: ORIGIN }, payload: { token: first.server.launchToken } });
  assert.equal(result.statusCode, 204);
  const header = result.headers['set-cookie'];
  assert.match(header, /; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.ok(!header.includes('Domain='));
  const cookie = header.split(';', 1)[0];
  assert.equal((await get(first.app, '/api/v1/config', cookie)).statusCode, 200);
  assertError(await get(first.app, '/api/v1/config', `${cookie}; ${cookie}`), 401, 'UNAUTHORIZED');
  assertError(await get(second.app, '/api/v1/config', cookie), 401, 'UNAUTHORIZED');
  // A second independent browser bootstraps the same launch capability.
  const secondBrowser = await authenticate(first.server);
  assert.equal((await get(first.app, '/api/v1/config', secondBrowser)).statusCode, 200);
});

test('only whitelisted DTO fields are exposed and review mutation remains unavailable', async t => {
  const { server, app } = await serverFixture(t);
  const cookie = await authenticate(server);
  const config = (await get(app, '/api/v1/config', cookie)).json();
  assert.deepEqual(Object.keys(config).sort(), ['apiVersion', 'capabilities', 'defaultProjectId', 'history', 'repository']);
  assert.equal(config.defaultProjectId, PROJECT_ID);
  assert.equal(config.capabilities.startReview, false);
  assert.equal(config.capabilities.cancelReview, false);
  assert.equal(config.capabilities.feedback, false);
  assert.equal(config.capabilities.learning, false);
  const history = await get(app, `/api/v1/projects/${PROJECT_ID}/reviews?status=completed&scope=staged&limit=20`, cookie);
  assert.deepEqual(history.json().items, [ITEM]);
  assert.equal((await get(app, `/api/v1/projects/${PROJECT_ID}/tasks/${RUN_ID}`, cookie)).json().canCancel, false);
  assert.deepEqual((await get(app, `/api/v1/projects/${PROJECT_ID}/runs/${RUN_ID}/report`, cookie)).json(), REPORT);
  const evidence = await get(app, `/api/v1/projects/${PROJECT_ID}/runs/${RUN_ID}/findings/${encodeFindingId('division')}/evidence/0`, cookie);
  assert.equal(evidence.json().findingId, 'division');
  assertError(await app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/reviews`, headers: { host: HOST, cookie }, payload: {} }), 405, 'METHOD_NOT_ALLOWED');
  assertError(await get(app, '/api/v1/skills', cookie), 404, 'NOT_FOUND');
});

test('project registration requires authenticated same-origin requests and strict bounded bodies', async t => {
  const calls = [];
  const { server, app } = await serverFixture(t, fakeService({ defaultProjectId: PROJECT_ID,
    async registerProject(value) { calls.push(['project', value]); return PROJECT; },
    async registerWorkspace(id, value) { calls.push(['workspace', id, value]); return PROJECT; },
  }));
  const cookie = await authenticate(server);
  const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, headers: { host: HOST, cookie, origin: ORIGIN, ...headers }, payload });
  assertError(await get(app, '/api/v1/projects'), 401, 'UNAUTHORIZED');
  assert.deepEqual((await get(app, '/api/v1/projects', cookie)).json(), { defaultProjectId: PROJECT_ID, projects: [PROJECT] });
  const config = (await get(app, '/api/v1/config', cookie)).json();
  assert.equal(config.defaultProjectId, PROJECT_ID); assert.equal(config.capabilities.manageProjects, true); assert.equal(config.capabilities.readDiff, true);
  assertError(await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { host: HOST, origin: ORIGIN }, payload: { repositoryPath: '/fixture/second' } }), 401, 'UNAUTHORIZED');
  assertError(await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { host: HOST, cookie }, payload: { repositoryPath: '/fixture/second' } }), 403, 'INVALID_ORIGIN');
  assertError(await post('/api/v1/projects', { repositoryPath: '/fixture/second' }, { origin: 'https://attacker.invalid' }), 403, 'INVALID_ORIGIN');
  for (const body of [{ repositoryPath: '/fixture/second', stateDir: '/private/state' }, { repositoryPath: '../outside', name: '' }, { repositoryPath: 'x'.repeat(4097) }, []]) {
    assertError(await post('/api/v1/projects', body), 400, 'INVALID_BODY');
  }
  assertError(await post('/api/v1/projects?repo=outside', { repositoryPath: '/fixture/second' }), 400, 'INVALID_QUERY');
  assertError(await post('/api/v1/projects/not-a-uuid/workspaces', { repositoryPath: '/fixture/worktree' }), 400, 'INVALID_PARAMS');
  assert.equal(calls.length, 0);
  assert.deepEqual((await post('/api/v1/projects', { repositoryPath: '/fixture/second', name: 'Second project' })).json(), PROJECT);
  assert.deepEqual((await post(`/api/v1/projects/${PROJECT_ID}/workspaces`, { repositoryPath: '/fixture/worktree', name: 'Worktree' })).json(), PROJECT);
  assert.deepEqual(calls, [['project', { repositoryPath: '/fixture/second', name: 'Second project' }],
    ['workspace', PROJECT_ID, { repositoryPath: '/fixture/worktree', name: 'Worktree' }]]);
  assertError(await post(`/api/v1/projects/${PROJECT_ID}/reviews`, {}), 405, 'METHOD_NOT_ALLOWED');
  assertError(await app.inject({ method: 'DELETE', url: `/api/v1/projects/${PROJECT_ID}`, headers: { host: HOST, cookie, origin: ORIGIN } }), 405, 'METHOD_NOT_ALLOWED');
  const oversized = await post('/api/v1/projects', JSON.stringify({ repositoryPath: 'x'.repeat(17 * 1024) }), { 'content-type': 'application/json' });
  assertError(oversized, 413, 'INVALID_BODY');
});

test('project read routes pass the explicit project and frozen diff query without accepting source paths', async t => {
  const calls = [];
  const original = fakeService();
  const service = fakeService({
    async listReviews(projectId, query) { calls.push(['history', query, projectId]); return original.listReviews(); },
    async task(projectId, id) { calls.push(['task', id, projectId]); return original.task(); },
    async report(projectId, id) { calls.push(['report', id, projectId]); return original.report(); },
    async evidence(projectId, id, findingId, index) { calls.push(['evidence', id, findingId, index, projectId]); return original.evidence(projectId, id, findingId, index); },
    async evidenceDiff(projectId, id, findingId, index, query) { calls.push(['diff', id, findingId, index, query, projectId]); return original.evidenceDiff(projectId, id, findingId, index, query); },
  });
  const { server, app } = await serverFixture(t, service), cookie = await authenticate(server);
  const prefix = `/api/v1/projects/${PROJECT_ID}`, findingId = '../中文/%';
  const evidencePath = `/runs/${RUN_ID}/findings/${encodeFindingId(findingId)}/evidence/0`;
  assert.equal((await get(app, `${prefix}/reviews?workspaceId=${PROJECT.workspaces[0].id}`, cookie)).statusCode, 200);
  assert.equal((await get(app, `${prefix}/tasks/${RUN_ID}`, cookie)).statusCode, 200);
  assert.equal((await get(app, `${prefix}/runs/${RUN_ID}/report`, cookie)).statusCode, 200);
  assert.equal((await get(app, `${prefix}${evidencePath}`, cookie)).json().findingId, findingId);
  const diff = await get(app, `${prefix}${evidencePath}/diff?offset=1&limit=2`, cookie);
  assert.equal(diff.statusCode, 200, diff.body); assert.equal(diff.json().findingId, findingId);
  assert.equal(diff.json().diff.rows.length, 2); assert.equal(diff.json().diff.nextOffset, 3);
  assert.deepEqual(calls, [['history', { workspaceId: PROJECT.workspaces[0].id, limit: 20 }, PROJECT_ID],
    ['task', RUN_ID, PROJECT_ID], ['report', RUN_ID, PROJECT_ID], ['evidence', RUN_ID, findingId, 0, PROJECT_ID],
    ['diff', RUN_ID, findingId, 0, { offset: 1, limit: 2 }, PROJECT_ID]]);
  for (const query of ['path=../../private.txt', 'repo=/outside', 'limit=201', 'offset=-1', 'offset=1&offset=2']) {
    assertError(await get(app, `${prefix}${evidencePath}/diff?${query}`, cookie), 400, 'INVALID_QUERY');
  }
  assertError(await get(app, `/api/v1/projects/invalid${evidencePath}/diff`, cookie), 400, 'INVALID_PARAMS');
  assert.equal(calls.length, 5);
  assertError(await get(app, `/api/v1${evidencePath}/diff`, cookie), 404, 'NOT_FOUND');
  assert.equal(calls.length, 5);
});

test('registry and diff outputs enforce whitelists and exact frozen evidence identity', async t => {
  const secret = 'private-state/auth/provider-secret';
  const original = fakeService();
  let invalidDiff = false;
  const { server, app } = await serverFixture(t, fakeService({
    async listProjects() { return { defaultProjectId: PROJECT_ID, projects: [{ ...PROJECT, stateDir: secret }] }; },
    async registerProject() { throw Error(secret); },
    async evidenceDiff(...args) {
      const result = await original.evidenceDiff(...args);
      return { ...result, diff: { ...result.diff, ...(invalidDiff ? { path: 'different.py' } : { providerSecret: secret }) } };
    },
  }));
  const cookie = await authenticate(server);
  const projects = await get(app, '/api/v1/projects', cookie);
  assertError(projects, 409, 'RESPONSE_INVALID'); assert.ok(!projects.body.includes(secret));
  const registered = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { host: HOST, cookie, origin: ORIGIN }, payload: { repositoryPath: '/fixture/new' } });
  assertError(registered, 500, 'INTERNAL_ERROR'); assert.ok(!registered.body.includes(secret));
  const path = `/api/v1/projects/${PROJECT_ID}/runs/${RUN_ID}/findings/${encodeFindingId('division')}/evidence/0/diff`;
  const extra = await get(app, path, cookie);
  assertError(extra, 409, 'RESPONSE_INVALID'); assert.ok(!extra.body.includes(secret));
  invalidDiff = true;
  assertError(await get(app, path, cookie), 409, 'RESPONSE_INVALID');
});

test('query and route schemas reject invalid input without calling storage', async t => {
  let calls = 0;
  const { server, app } = await serverFixture(t, fakeService({ async listReviews() { calls++; throw Error('must not call'); } }));
  const cookie = await authenticate(server);
  for (const path of [`/api/v1/projects/${PROJECT_ID}/reviews?limit=0`, `/api/v1/projects/${PROJECT_ID}/reviews?limit=51`, `/api/v1/projects/${PROJECT_ID}/reviews?scope=unknown`, `/api/v1/projects/${PROJECT_ID}/reviews?repo=outside`, `/api/v1/projects/${PROJECT_ID}/reviews?limit=1&limit=2`]) {
    assertError(await get(app, path, cookie), 400, 'INVALID_QUERY');
  }
  assert.equal(calls, 0);
  assertError(await get(app, '/api/v1/config?apiKey=hidden', cookie), 400, 'INVALID_QUERY');
  for (const path of ['/api/v1/reviews', `/api/v1/tasks/${RUN_ID}`, `/api/v1/runs/${RUN_ID}/report`]) assertError(await get(app, path, cookie), 404, 'NOT_FOUND');
  assertError(await get(app, `/api/v1/projects/${PROJECT_ID}/tasks/not-a-uuid`, cookie), 400, 'INVALID_PARAMS');
  assertError(await get(app, `/api/v1/projects/${PROJECT_ID}/runs/${RUN_ID}/findings/${encodeFindingId('division')}/evidence/20`, cookie), 400, 'INVALID_PARAMS');
  assertError(await get(app, `/api/v1/projects/${PROJECT_ID}/runs/${RUN_ID}/findings/raw-division/evidence/0`, cookie), 400, 'INVALID_PARAMS');
});

test('opaque finding segments preserve Unicode, percent, slash, dot-only and long IDs', async t => {
  const values = ['中文问题', 'finding%25', 'group/finding', '..', '.', 'x/../%/中文', '中'.repeat(4000)];
  const received = [];
  const service = fakeService();
  const original = service.evidence;
  service.evidence = async (project, run, finding, index) => { received.push(finding); return original(project, run, finding, index); };
  const { server, app } = await serverFixture(t, service);
  const cookie = await authenticate(server);
  for (const value of values) {
    const response = await get(app, `/api/v1/projects/${PROJECT_ID}/runs/${RUN_ID}/findings/${encodeFindingId(value)}/evidence/0`, cookie);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().findingId, value);
  }
  assert.deepEqual(received, values);
});

test('compiled assets and SPA refreshes are safe, and authenticated startup also scrubs fragments', async t => {
  const { server, app } = await serverFixture(t);
  const cookie = await authenticate(server);
  const page = await get(app, '/', cookie);
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.indexOf(scrubFragmentScript) < page.body.indexOf('src="/assets/app.js"'));
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.ok(page.body.includes('Compiled app fixture'));
  const refresh = await get(app, `/reviews/${RUN_ID}`, cookie, { accept: 'text/html' });
  assert.equal(refresh.statusCode, 200);
  assert.equal((await get(app, '/assets/app.js', cookie)).statusCode, 200);
  assertError(await get(app, `/reviews/${RUN_ID}`, cookie, { accept: 'application/json' }), 404, 'NOT_FOUND');
  assertError(await get(app, '/missing.js', cookie, { accept: 'text/html' }), 404, 'ASSET_NOT_FOUND');
  assertError(await get(app, '/package.json', cookie, { accept: 'text/html' }), 404, 'NOT_FOUND');
  assertError(await get(app, '/src/main.ts', cookie), 404, 'NOT_FOUND');
  assertError(await get(app, '/api/v2/config', cookie, { accept: 'text/html' }), 404, 'NOT_FOUND');
  for (const path of ['/../package.json', '/assets/%2e%2e/%2e%2e/secret.js', '/assets/%252e%252e/secret.js', '/assets\\..\\secret.js', '/assets/%00secret.js']) {
    assert.throws(() => requestPath(path), error => error.code === 'INVALID_PATH');
    const denied = await get(app, path, cookie);
    // HTTP clients/routers may normalize or reject the target before onRequest.
    // Such targets must still never read a file or enter the SPA fallback.
    assert.ok([400, 404].includes(denied.statusCode), `${path}: ${denied.body}`);
    assert.ok(denied.json().error.code);
  }
});

test('static serving rejects directory links even when requested extension is allowed', async t => {
  const { server, app, directory, assetsDir } = await serverFixture(t);
  const external = join(directory, 'outside');
  await mkdir(external); await writeFile(join(external, 'secret.js'), 'outside fixture secret');
  await symlink(external, join(assetsDir, 'linked'), 'junction');
  const response = await get(app, '/linked/secret.js', await authenticate(server));
  assertError(response, 400, 'INVALID_PATH');
  assert.ok(!response.body.includes('outside fixture secret'));
});

test('invalid output, storage exceptions and malformed bootstrap bodies never disclose secrets', async t => {
  const secret = 'hidden-provider-secret-/private/state/auth.json';
  const { server, app } = await serverFixture(t, fakeService({
    async listReviews() { return { repositoryPath: ITEM.repositoryPath, items: [{ ...ITEM, model: { ...ITEM.model, apiKey: secret } }], nextCursor: null, sync: { lastSyncedAt: null, scanned: 1, skipped: 0, truncated: false } }; },
    async report() { throw Error(secret); },
    async task() { throw new WorkbenchError('NOT_FOUND', 'Review was not found.', 404); },
  }));
  const cookie = await authenticate(server);
  const invalid = await get(app, `/api/v1/projects/${PROJECT_ID}/reviews`, cookie);
  assertError(invalid, 409, 'RESPONSE_INVALID');
  assert.ok(!invalid.body.includes(secret));
  const failure = await get(app, `/api/v1/projects/${PROJECT_ID}/runs/${RUN_ID}/report`, cookie);
  assertError(failure, 500, 'INTERNAL_ERROR');
  assert.ok(!failure.body.includes(secret));
  assertError(await get(app, `/api/v1/projects/${PROJECT_ID}/tasks/${RUN_ID}`, cookie), 404, 'NOT_FOUND');
  const malformed = await app.inject({ method: 'POST', url: '/_workbench/session', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' }, payload: '{"token":' });
  assertError(malformed, 400, 'INVALID_BODY');
  const oversized = await app.inject({ method: 'POST', url: '/_workbench/session', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify({ token: 'a'.repeat(2000) }) });
  assertError(oversized, 413, 'INVALID_BODY');
});

test('launcher accepts only repo/state/port and requires no model credentials', () => {
  const options = parseLaunchOptions(['--repo', '.', '--state', '../state', '--port', '0']);
  assert.equal(options.port, 0);
  assert.ok(options.repositoryPath);
  for (const argv of [[], ['--repo'], ['--repo', '.', '--host', '0.0.0.0'], ['--repo', '.', '--port', '65536'], ['--repo', '.', '--port', '-1'], ['--repo', '.', '--repo', '.'], ['--repo', '.', '--provider', 'fixture']]) {
    assert.throws(() => parseLaunchOptions(argv), error => error.code === 'CONFIGURATION');
  }
});
