import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { appCsp, scrubFragmentScript } from './bootstrap.ts';
import { HttpError } from './http-error.ts';

const mimeTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const inside = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

/** Validate the original target before Fastify/URL normalization can erase traversal. */
export function requestPath(target: string): string {
  const raw = target.split('?', 1)[0]!;
  if (!raw.startsWith('/') || raw.startsWith('//')) throw new HttpError('INVALID_PATH', 'Request path is invalid.', 400);
  let path: string;
  try { path = decodeURIComponent(raw); } catch { throw new HttpError('INVALID_PATH', 'Request path encoding is invalid.', 400); }
  // Finding IDs are opaque strings, including %, slashes and dot segments.
  // They are schema-checked route values, never filesystem paths. Do not decode
  // or normalize their identity a second time before the router reads them.
  if (raw === '/api' || raw.startsWith('/api/')) return raw;
  if (/[\\\x00-\x1f\x7f]/.test(path) || path.includes('%') || path.split('/').some(part => part === '.' || part === '..')) {
    throw new HttpError('INVALID_PATH', 'Request path is invalid.', 400);
  }
  return path;
}

export class AssetStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private async read(path: string): Promise<Buffer> {
    let root: string;
    try { root = await realpath(this.directory); }
    catch { throw new HttpError('ASSETS_UNAVAILABLE', 'Build the Workbench frontend before starting the server.', 503); }
    const target = resolve(root, path);
    if (!inside(root, target)) throw new HttpError('INVALID_PATH', 'Asset path is invalid.', 400);
    // Reject links at every component, including links that happen to remain in dist.
    const parts = relative(root, target).split(sep);
    let current = root;
    for (const part of parts) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new HttpError('INVALID_PATH', 'Linked assets are not served.', 400);
    }
    const canonical = await realpath(target);
    const info = await lstat(canonical);
    if (!inside(root, canonical) || !info.isFile() || info.size > 8 * 1024 * 1024) {
      throw new HttpError('ASSET_NOT_FOUND', 'Asset was not found.', 404);
    }
    return readFile(canonical);
  }
  async response(path: string, acceptsHtml: boolean): Promise<{ content: Buffer | string; contentType: string; csp?: string }> {
    if (path.startsWith('/api') || path.startsWith('/_workbench') || path.includes(':') ||
      path.split('/').some(part => part.startsWith('.')) || /%2f|%5c/i.test(path)) {
      throw new HttpError('NOT_FOUND', 'Route was not found.', 404);
    }
    const extension = extname(path);
    if (path === '/' || path === '/index.html' || (!extension && acceptsHtml)) {
      let html: string;
      try { html = (await this.read('index.html')).toString('utf8'); }
      catch (error) {
        if (missing(error)) throw new HttpError('ASSETS_UNAVAILABLE', 'Build the Workbench frontend before starting the server.', 503);
        throw error;
      }
      if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new HttpError('ASSETS_UNAVAILABLE', 'Workbench frontend entry is invalid. Rebuild it before starting the server.', 503);
      return { content: html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<script>${scrubFragmentScript}</script>`), contentType: 'text/html; charset=utf-8', csp: appCsp };
    }
    const contentType = mimeTypes[extension];
    if (!contentType) throw new HttpError('NOT_FOUND', 'Route was not found.', 404);
    try { return { content: await this.read(path.slice(1)), contentType }; }
    catch (error) {
      if (missing(error)) throw new HttpError('ASSET_NOT_FOUND', 'Asset was not found.', 404);
      throw error;
    }
  }
}
