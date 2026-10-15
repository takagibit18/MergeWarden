import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod/v4';
import { HttpError } from './http-error.ts';

export const sessionBodySchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const equals = (left: string, right: string): boolean => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Credentials live only in this foreground process; no credentials/config are read. */
export class LocalAuth {
  readonly launchToken = randomBytes(32).toString('base64url');
  private readonly cookieName = `mw_workbench_${randomBytes(8).toString('hex')}`;
  private readonly cookieValue = randomBytes(32).toString('base64url');
  private expectedOrigin: string | undefined;
  private stopped = false;

  constructor(origin?: string) { if (origin) this.setOrigin(origin); }
  setOrigin(origin: string): void {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new HttpError('CONFIGURATION', 'Workbench must use an IPv4 loopback HTTP origin.', 400);
    }
    this.expectedOrigin = parsed.origin;
  }
  get origin(): string {
    if (!this.expectedOrigin || this.stopped) throw new HttpError('SERVER_UNAVAILABLE', 'Workbench is not accepting requests.', 503);
    return this.expectedOrigin;
  }
  get launchUrl(): string { return `${this.origin}/#token=${this.launchToken}`; }

  validateRequest(request: FastifyRequest): void {
    const host = new URL(this.origin).host;
    const raw = request.raw.rawHeaders;
    let hostCount = 0, originCount = 0;
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i]?.toLowerCase() === 'host') hostCount++;
      if (raw[i]?.toLowerCase() === 'origin') originCount++;
    }
    if (hostCount !== 1 || request.headers.host !== host) throw new HttpError('INVALID_HOST', 'Request Host does not match this Workbench.', 403);
    const origin = request.headers.origin;
    if (originCount > 1 || (origin !== undefined && origin !== this.origin)) {
      throw new HttpError('INVALID_ORIGIN', 'Cross-origin requests are not permitted.', 403);
    }
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new HttpError('INVALID_ORIGIN', 'Cross-origin requests are not permitted.', 403);
    }
  }
  authenticate(request: FastifyRequest): boolean {
    if (this.stopped) return false;
    const cookie = request.headers.cookie;
    if (typeof cookie !== 'string' || cookie.length > 8192) return false;
    const values = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${this.cookieName}=`));
    if (values.length !== 1) return false;
    return equals(values[0]!.slice(this.cookieName.length + 1), this.cookieValue);
  }
  bootstrap(request: FastifyRequest, body: unknown): string {
    if (request.headers.origin !== this.origin) throw new HttpError('INVALID_ORIGIN', 'Session bootstrap requires this Workbench origin.', 403);
    const parsed = sessionBodySchema.safeParse(body);
    if (!parsed.success || !equals(parsed.data.token, this.launchToken)) throw new HttpError('UNAUTHORIZED', 'Open the startup URL to connect to this Workbench.', 401);
    return `${this.cookieName}=${this.cookieValue}; Path=/; HttpOnly; SameSite=Strict`;
  }
  close(): void { this.stopped = true; this.expectedOrigin = undefined; }
}
