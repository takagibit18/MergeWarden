import { openWorkbench } from '../../../src/composition/workbench.ts';
import { HttpError } from './http-error.ts';
import { createWorkbenchServer } from './server.ts';
import type { WorkbenchHttpServer } from './server.ts';

export interface LaunchOptions {
  repositoryPath: string;
  stateDir: string;
  port?: number;
  assetsDir?: string;
  syncBatchSize?: number;
}
export interface RunningWorkbench {
  url: string;
  origin: string;
  port: number;
  app: WorkbenchHttpServer['app'];
  close(): Promise<void>;
}

export async function launchWorkbench(options: LaunchOptions): Promise<RunningWorkbench> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HttpError('CONFIGURATION', 'Port must be an integer between 0 and 65535.', 400);
  const service = await openWorkbench({
    repositoryPath: options.repositoryPath, stateDir: options.stateDir,
    ...(options.syncBatchSize !== undefined ? { syncBatchSize: options.syncBatchSize } : {}),
  });
  let server: WorkbenchHttpServer;
  try { server = createWorkbenchServer({ service, ...(options.assetsDir ? { assetsDir: options.assetsDir } : {}) }); }
  catch (error) { await service.close(); throw error; }
  try {
    // Deliberately fixed; neither CLI options nor reviewed configuration can widen this.
    await server.app.listen({ host: '127.0.0.1', port });
    const address = server.app.server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new HttpError('SERVER_UNAVAILABLE', 'Workbench loopback listener could not be verified.', 503);
    const origin = `http://127.0.0.1:${address.port}`;
    server.setOrigin(origin);
    return { url: server.launchUrl, origin, port: address.port, app: server.app, close: () => server.close() };
  } catch (error) {
    await server.close();
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EPERM') throw new HttpError('PORT_UNAVAILABLE', 'The requested loopback port is unavailable. Choose another port or use --port 0.', 503);
    throw error;
  }
}
