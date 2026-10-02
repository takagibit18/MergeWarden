import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { InferenceOptions, RuntimeFactory } from '../../../src/engine/contracts.ts';
import { isolatedState } from '../../../src/infrastructure/files.ts';
import { ReviewTasks } from './reviews.ts';
import { createReviewServer } from './server.ts';
import { ToolError } from './schemas.ts';

const HELP = `MergeWarden local STDIO MCP (Node.js 22.19+)
node --experimental-strip-types integrations/mcp/src/main.ts --repo PATH --provider NAME --model ID --auth oauth [--state OUTSIDE_PATH]
node --experimental-strip-types integrations/mcp/src/main.ts --repo PATH --provider NAME --model ID --api-key-env NAME [--state OUTSIDE_PATH]
Optional: --thinking LEVEL --max-output-tokens N --skills auto|off
Only MCP JSON-RPC is written to stdout. Login separately with the existing CLI and the same state.
The repository, state, provider, model and authentication are fixed for this server. Tools cannot override them.`;

async function main(argv: string[]) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) { console.log(HELP); return; }
  const values = new Map<string, string>();
  const known = new Set(['repo', 'state', 'provider', 'model', 'auth', 'api-key-env', 'thinking', 'max-output-tokens', 'skills']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !key || !known.has(key) || values.has(key) || !value || value.startsWith('--')) throw new ToolError('CONFIGURATION', 'Invalid, duplicate or incomplete startup option. Use --help.');
    values.set(key, value);
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new ToolError('CONFIGURATION', `Missing --${key}. Use --help.`); return value; };
  const repositoryPath = resolve(required('repo'));
  const stateDir = await isolatedState(resolve(values.get('state') ?? join(process.env.LOCALAPPDATA ?? homedir(), 'MergeWarden2')), repositoryPath);
  const model = { provider: required('provider'), modelId: required('model') };
  const mode = values.get('auth') ?? 'api-key';
  let authentication: string | { type: 'oauth'; authPath: string };
  if (mode === 'oauth') {
    if (values.has('api-key-env')) throw new ToolError('CONFIGURATION', 'OAuth and API-key authentication are mutually exclusive.');
    authentication = { type: 'oauth', authPath: join(await isolatedState(join(stateDir, 'auth'), repositoryPath), 'auth.json') };
  } else {
    if (mode !== 'api-key') throw new ToolError('CONFIGURATION', 'Authentication must be oauth or api-key.');
    const variable = required('api-key-env');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) || !process.env[variable]?.trim()) throw new ToolError('CONFIGURATION', 'Set the explicitly named API key environment variable before starting the server.');
    authentication = process.env[variable]!;
  }
  const thinking = values.get('thinking');
  if (thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new ToolError('CONFIGURATION', 'Invalid thinking level.');
  const maxOutputTokens = values.has('max-output-tokens') ? Number(values.get('max-output-tokens')) : undefined;
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)) throw new ToolError('CONFIGURATION', 'Output token budget must be a positive integer.');
  const skills = values.get('skills') ?? 'auto';
  if (skills !== 'auto' && skills !== 'off') throw new ToolError('CONFIGURATION', 'Skills must be auto or off.');
  const inference: InferenceOptions = { ...(thinking ? { thinkingLevel: thinking as NonNullable<InferenceOptions['thinkingLevel']> } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) };
  const pi = await import(new URL('../../pi/src/runtime.ts', import.meta.url).href) as { createPiRuntimeFactory(auth: typeof authentication): RuntimeFactory };
  const tasks = await ReviewTasks.create({ repositoryPath, stateDir, model, skills, ...(Object.keys(inference).length ? { inference } : {}) }, pi.createPiRuntimeFactory(authentication));
  const connection = serveStdio(() => createReviewServer(tasks), { onerror: () => console.error('MergeWarden MCP transport error.') });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await tasks.close(); await connection.close(); }
    finally { process.exit(0); }
  };
  process.stdin.once('end', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
}

try { await main(process.argv.slice(2)); }
catch (error) {
  const data = error instanceof ToolError ? { code: error.code, message: error.message }
    : { code: 'SERVER_UNAVAILABLE', message: 'Cannot start MergeWarden MCP. Check Node.js, npm run setup, and the configured repository/state paths. Credential details are not printed.' };
  console.error(JSON.stringify({ error: data })); process.exitCode = 2;
}
