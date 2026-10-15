import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http-error.ts';
import type { LaunchOptions } from './launch.ts';
import { WorkbenchError } from '../../../src/ports/workbench-errors.ts';

export const HELP = `MergeWarden local read-only Workbench (Node.js 22.19+)
node --experimental-strip-types integrations/workbench/src/main.ts --repo PATH [--state OUTSIDE_PATH] [--port N]
Defaults: --port 0 selects an available loopback port; --state uses the existing MergeWarden2 data directory.
Build the frontend first, then open the printed URL in Codex or an external browser.
The foreground process serves app and API on one loopback origin. Ctrl+C closes its HTTP listener and SQLite projection.
No model, authentication-provider credentials, review starts or cancellations are required or supported.`;

export function parseLaunchOptions(argv: string[]): LaunchOptions {
  const values = new Map<string, string>();
  const known = new Set(['repo', 'state', 'port']);
  for (let i = 0; i < argv.length; i += 2) {
    const option = argv[i], key = option?.slice(2), value = argv[i + 1];
    if (!option?.startsWith('--') || !key || !known.has(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new HttpError('CONFIGURATION', 'Invalid, duplicate or incomplete startup option. Use --help.', 400);
    }
    values.set(key, value);
  }
  if (!values.get('repo')) throw new HttpError('CONFIGURATION', 'Missing --repo. Use --help.', 400);
  const rawPort = values.get('port') ?? '0';
  if (!/^(?:0|[1-9]\d{0,4})$/.test(rawPort) || Number(rawPort) > 65535) throw new HttpError('CONFIGURATION', 'Port must be an integer between 0 and 65535.', 400);
  return {
    repositoryPath: resolve(values.get('repo')!),
    stateDir: resolve(values.get('state') ?? join(process.env.LOCALAPPDATA ?? homedir(), 'MergeWarden2')),
    port: Number(rawPort),
  };
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) { console.log(HELP); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!major || major < 22 || (major === 22 && (minor ?? 0) < 19)) throw new HttpError('CONFIGURATION', 'Workbench requires Node.js 22.19 or newer.', 400);
  const options = parseLaunchOptions(argv);
  const { launchWorkbench } = await import('./launch.ts');
  const running = await launchWorkbench(options);
  // Intentional launch capability entry only. Request/access/error logs stay disabled.
  console.log(`MergeWarden Workbench: ${running.url}`);
  await new Promise<void>(resolveStopped => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      running.close().catch(() => {
        process.exitCode = 2;
        console.error('MergeWarden Workbench could not finish its local shutdown.');
      }).finally(() => {
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        resolveStopped();
      });
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const safe = error instanceof HttpError || error instanceof WorkbenchError;
    console.error(JSON.stringify({ error: {
      code: safe ? error.code : 'STARTUP_FAILED',
      message: safe ? error.message : 'MergeWarden Workbench could not start. Check repository, state and frontend build.',
      traceId: randomUUID(),
    } }));
    process.exitCode = 2;
  });
}
