import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod/v4';
import {
  configResponseSchema, errorResponseSchema, evidenceParamsSchema, evidenceResponseSchema,
  historyQuerySchema, historyResponseSchema, reportResponseSchema, taskParamsSchema, taskResponseSchema, decodeFindingId,
  projectsResponseSchema, projectSchema, projectRegistrationSchema, workspaceRegistrationSchema,
  diffQuerySchema, evidenceDiffResponseSchema,
} from '@mergewarden/contracts';
import type { ConfigResponse } from '@mergewarden/contracts';
import { WorkbenchError } from '../../../src/application/workbench-service.ts';
import type { WorkbenchService } from '../../../src/application/workbench-service.ts';
import { AssetStore, requestPath } from './assets.ts';
import { bootstrapCsp, bootstrapHtml } from './bootstrap.ts';
import { HttpError } from './http-error.ts';
import { LocalAuth } from './local-auth.ts';

export type ReadService = Pick<WorkbenchService, 'repositoryPath' | 'defaultProjectId' | 'listProjects' | 'registerProject' |
  'registerWorkspace' | 'listReviews' | 'task' | 'report' | 'evidence' | 'evidenceDiff' | 'close'>;
export interface ServerOptions {
  service: ReadService;
  assetsDir?: string;
  /** Injection tests supply a loopback origin; the launcher sets the bound port. */
  origin?: string;
}
export interface WorkbenchHttpServer {
  app: FastifyInstance;
  readonly launchToken: string;
  readonly launchUrl: string;
  setOrigin(origin: string): void;
  close(): Promise<void>;
}
const noQuerySchema = z.object({}).strict();
const defaultAssets = fileURLToPath(new URL('../../../apps/workbench/dist/', import.meta.url));

function input<T>(schema: z.ZodType<T>, value: unknown, code = 'INVALID_QUERY'): T {
  const checked = schema.safeParse(value);
  if (checked.success) return checked.data;
  const fields: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const issue of checked.error.issues.slice(0, 20)) {
    const key = issue.path.map(String).join('.') || 'request';
    fields[key] ??= [];
    fields[key]!.push(issue.message.slice(0, 256));
  }
  throw new HttpError(code, 'Request parameters are invalid.', 400, fields);
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const checked = schema.safeParse(value);
  if (!checked.success) throw new HttpError('RESPONSE_INVALID', 'Saved review data cannot be safely displayed.', 409);
  return checked.data;
}
function sendError(request: FastifyRequest, reply: FastifyReply, code: string, message: string, statusCode: number, fieldErrors?: Record<string, string[]>) {
  return reply.code(statusCode).send(errorResponseSchema.parse({ error: {
    code, message, ...(fieldErrors ? { fieldErrors } : {}), traceId: request.id,
  } }));
}
const config = (service: ReadService): ConfigResponse => ({
  apiVersion: 'v1', repository: { path: service.repositoryPath, name: basename(service.repositoryPath) },
  ...(service.defaultProjectId ? { defaultProjectId: service.defaultProjectId } : {}),
  capabilities: { readHistory: true, readReport: true, readEvidence: true,
    ...(service.defaultProjectId ? { manageProjects: true, readDiff: true } : {}),
    startReview: false, cancelReview: false, feedback: false, learning: false },
  history: { defaultLimit: 20, maxLimit: 50 },
});

/** Thin evidence transport plus explicit host project registration. No Pi/model imports. */
export function createWorkbenchServer(options: ServerOptions): WorkbenchHttpServer {
  const auth = new LocalAuth(options.origin);
  const assets = new AssetStore(options.assetsDir ?? defaultAssets);
  const app = Fastify({
    logger: false, requestIdHeader: false, genReqId: () => randomUUID(), trustProxy: false,
    bodyLimit: 1024, requestTimeout: 10_000, connectionTimeout: 10_000,
    keepAliveTimeout: 5000, forceCloseConnections: true, exposeHeadRoutes: false,
    onProtoPoisoning: 'error', onConstructorPoisoning: 'error',
    // The opaque JSON/base64url segment preserves all native UTF-16 IDs and can
    // reach 32,005 characters. Keep both router and HTTP headers bounded.
    routerOptions: { maxParamLength: 40_000 }, http: { maxHeaderSize: 48 * 1024 },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    auth.validateRequest(request);
    const path = requestPath(request.raw.url ?? request.url);
    if (path === '/_workbench/session' && request.method === 'POST') return;
    const registration = request.method === 'POST' &&
      (path === '/api/v1/projects' || /^\/api\/v1\/projects\/[^/]+\/workspaces$/.test(path));
    if (request.method !== 'GET' && !registration) {
      reply.header('Allow', 'GET');
      throw new HttpError('METHOD_NOT_ALLOWED', 'Only read-only GET endpoints are supported.', 405);
    }
    if (path.startsWith('/api') && !auth.authenticate(request)) {
      throw new HttpError('UNAUTHORIZED', 'Open the startup URL to connect to this Workbench.', 401);
    }
    if (registration && request.headers.origin !== auth.origin) {
      throw new HttpError('INVALID_ORIGIN', 'Project registration requires this Workbench origin.', 403);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return sendError(request, reply, error.code, error.message, error.statusCode, error.fieldErrors);
    if (error instanceof WorkbenchError) return sendError(request, reply, error.code, error.message, error.statusCode);
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendError(request, reply, 'INVALID_BODY', 'Request body exceeds the local request limit.', 413);
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return sendError(request, reply, 'INVALID_BODY', 'Request requires a valid JSON body.', 400);
    }
    if ((error as { statusCode?: number }).statusCode === 400) return sendError(request, reply, 'INVALID_REQUEST', 'Request is malformed.', 400);
    return sendError(request, reply, 'INTERNAL_ERROR', 'Workbench could not complete this read request.', 500);
  });
  app.post('/_workbench/session', async (request, reply) => {
    input(noQuerySchema, request.query);
    reply.header('Set-Cookie', auth.bootstrap(request, request.body));
    return reply.code(204).send();
  });

  app.get('/api/v1/config', async request => {
    input(noQuerySchema, request.query);
    return output(configResponseSchema, config(options.service));
  });

  const projectId = (request: FastifyRequest): string | undefined => {
    const raw = request.params as Record<string, unknown>;
    return raw.projectId === undefined ? undefined : input(taskParamsSchema, { id: raw.projectId }, 'INVALID_PARAMS').id;
  };
  const runId = (request: FastifyRequest): string => {
    const raw = request.params as Record<string, unknown>;
    return input(taskParamsSchema, { id: raw.id }, 'INVALID_PARAMS').id;
  };
  const evidenceParams = (request: FastifyRequest) => {
    const raw = request.params as Record<string, unknown>;
    let decoded: string;
    try { decoded = decodeFindingId(String(raw.findingId)); }
    catch { throw new HttpError('INVALID_PARAMS', 'Finding identifier encoding is invalid.', 400, { findingId: ['Use an encoded finding identifier from the shared contract.'] }); }
    return input(evidenceParamsSchema, { id: raw.id, findingId: decoded, index: raw.index }, 'INVALID_PARAMS');
  };

  app.get('/api/v1/projects', async request => {
    input(noQuerySchema, request.query);
    return output(projectsResponseSchema, await options.service.listProjects());
  });
  app.post('/api/v1/projects', { bodyLimit: 16 * 1024 }, async request => {
    input(noQuerySchema, request.query);
    const registration = input(projectRegistrationSchema, request.body, 'INVALID_BODY');
    return output(projectSchema, await options.service.registerProject(registration));
  });
  app.post('/api/v1/projects/:projectId/workspaces', { bodyLimit: 16 * 1024 }, async request => {
    input(noQuerySchema, request.query);
    const id = projectId(request)!;
    const registration = input(workspaceRegistrationSchema, request.body, 'INVALID_BODY');
    return output(projectSchema, await options.service.registerWorkspace(id, registration));
  });

  for (const prefix of ['/api/v1', '/api/v1/projects/:projectId']) {
    app.get(`${prefix}/reviews`, async request => {
      const id = projectId(request);
      const query = input(historyQuerySchema, request.query);
      return output(historyResponseSchema, await options.service.listReviews(query, id));
    });
    app.get(`${prefix}/tasks/:id`, async request => {
      input(noQuerySchema, request.query);
      const id = projectId(request);
      return output(taskResponseSchema, await options.service.task(runId(request), id));
    });
    app.get(`${prefix}/runs/:id/report`, async request => {
      input(noQuerySchema, request.query);
      const id = projectId(request);
      return output(reportResponseSchema, await options.service.report(runId(request), id));
    });
    app.get(`${prefix}/runs/:id/findings/:findingId/evidence/:index`, async request => {
      input(noQuerySchema, request.query);
      const project = projectId(request);
      const { id, findingId, index } = evidenceParams(request);
      return output(evidenceResponseSchema, await options.service.evidence(id, findingId, index, project));
    });
    app.get(`${prefix}/runs/:id/findings/:findingId/evidence/:index/diff`, async request => {
      const project = projectId(request);
      const { id, findingId, index } = evidenceParams(request);
      const query = input(diffQuerySchema, request.query);
      return output(evidenceDiffResponseSchema, await options.service.evidenceDiff(id, findingId, index, query, project));
    });
  }

  const page = async (request: FastifyRequest, reply: FastifyReply) => {
    const path = requestPath(request.raw.url ?? request.url);
    const acceptsHtml = (request.headers.accept ?? '').split(',').some(value => value.trim().startsWith('text/html'));
    if (!auth.authenticate(request)) {
      if (path === '/' || path === '/index.html' || (acceptsHtml && !path.startsWith('/api') && !path.startsWith('/_workbench') && !path.split('/').at(-1)?.includes('.'))) {
        return reply.header('Content-Security-Policy', bootstrapCsp).type('text/html; charset=utf-8').send(bootstrapHtml);
      }
      throw new HttpError('UNAUTHORIZED', 'Open the startup URL to connect to this Workbench.', 401);
    }
    const response = await assets.response(path, acceptsHtml);
    if (response.csp) reply.header('Content-Security-Policy', response.csp);
    return reply.type(response.contentType).send(response.content);
  };
  app.get('/', page);
  app.get('/*', page);
  app.setNotFoundHandler((request, reply) => sendError(request, reply, 'NOT_FOUND', 'Route was not found.', 404));
  app.addHook('onClose', async () => { auth.close(); await options.service.close(); });
  return {
    app, get launchToken() { return auth.launchToken; }, get launchUrl() { return auth.launchUrl; },
    setOrigin(origin) { auth.setOrigin(origin); }, close() { return app.close(); },
  };
}
