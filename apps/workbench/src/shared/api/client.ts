import { errorResponseSchema } from '@mergewarden/contracts';

interface RuntimeSchema<T> { parse(input: unknown): T }

const errorMessages: Record<string, string> = {
  REPORT_INTEGRITY: '报告产物未通过完整性核验，无法确认交付。',
  EVIDENCE_INTEGRITY: '冻结源码证据未通过完整性核验，无法展示该引用。',
  NOT_DELIVERED: '该运行尚未确认报告交付，可返回历史查看任务状态。',
  NOT_FOUND: '未找到请求的运行、任务或证据。',
  STORAGE_UNAVAILABLE: '本地产物存储暂时无法读取，请检查服务状态后重试。',
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly traceId?: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function getJson<T>(path: string, schema: RuntimeSchema<T>, signal?: AbortSignal): Promise<T> {
  return requestJson(path, schema, 'GET', undefined, signal);
}

export async function postJson<T>(path: string, body: unknown, schema: RuntimeSchema<T>, signal?: AbortSignal): Promise<T> {
  return requestJson(path, schema, 'POST', body, signal);
}

async function requestJson<T>(path: string, schema: RuntimeSchema<T>, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('NETWORK_ERROR', '无法连接本地服务，请确认工作台服务仍在运行。', 0);
  }

  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ApiError('INVALID_RESPONSE', '本地服务返回了无法读取的响应。', response.status); }

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    if (parsed.success) {
      const { code, message, traceId, fieldErrors } = parsed.data.error;
      throw new ApiError(code, message, response.status, traceId, fieldErrors);
    }
    throw new ApiError('HTTP_ERROR', `读取失败（HTTP ${response.status}）。`, response.status);
  }
  try { return schema.parse(payload); }
  catch { throw new ApiError('CONTRACT_MISMATCH', '接口数据未通过格式核验，无法展示为可信报告。', response.status); }
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return '本地访问会话不可用，请通过工作台启动命令重新打开页面。';
    const message = errorMessages[error.code] ?? error.message;
    return error.traceId ? `${message}（诊断编号：${error.traceId}）` : message;
  }
  return '读取出现异常，请重试或检查本地服务。';
}

export function identityError(): ApiError {
  return new ApiError('IDENTITY_MISMATCH', '响应中的运行、快照或证据身份不一致，已停止展示。', 200);
}
