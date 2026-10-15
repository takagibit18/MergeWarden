import { createHash } from 'node:crypto';

// The fragment is removed before fetch, external resource loading or navigation.
// No token is interpolated into HTML, persisted, logged or sent in a URL/header.
const SCRIPT = `(() => {
  const fragment = window.location.hash.slice(1);
  window.history.replaceState(null, '', window.location.pathname);
  const token = new URLSearchParams(fragment).get('token');
  const message = document.getElementById('message');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  fetch('/_workbench/session', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
  }).then(response => {
    if (!response.ok) throw new Error('bootstrap');
    window.location.replace(window.location.pathname);
  }).catch(() => { message.textContent = '连接失败，请重新打开正在运行的 Workbench 打印的启动地址。'; });
})();`;
export const bootstrapCsp = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const bootstrapHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>MergeWarden 工作台</title></head><body><main><h1>MergeWarden 工作台</h1><p id="message">请打开正在运行的 Workbench 打印的启动地址以连接工作台。</p></main><script>${SCRIPT}</script></body></html>`;

// Reopening a launch URL with an existing cookie must also clear its fragment.
export const scrubFragmentScript = `if(window.location.hash)window.history.replaceState(null,'',window.location.pathname+window.location.search);`;
export const appCsp = `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(scrubFragmentScript).digest('base64')}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
