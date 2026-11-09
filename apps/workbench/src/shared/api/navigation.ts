import { navigationResponseSchema, navigationSourceResponseSchema, scopedTaskParamsSchema } from '@mergewarden/contracts';
import { getJson, identityError } from './client';

function runPath(projectId: string, runId: string) {
  scopedTaskParamsSchema.parse({ projectId, id: runId });
  return `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/navigation`;
}

/** Read-only navigation view of a delivered run. The server verifies it against run.json first. */
export async function getNavigation(projectId: string, runId: string, signal?: AbortSignal) {
  const response = await getJson(runPath(projectId, runId), navigationResponseSchema, signal);
  if (response.runId !== runId) throw identityError();
  return response;
}

/** Head source of one entity shown by the verified navigation view. */
export async function getNavigationSource(projectId: string, runId: string, entityId: string, signal?: AbortSignal) {
  const response = await getJson(`${runPath(projectId, runId)}/entities/${encodeURIComponent(entityId)}/source`, navigationSourceResponseSchema, signal);
  if (response.runId !== runId || response.entity.id !== entityId) throw identityError();
  return response;
}
