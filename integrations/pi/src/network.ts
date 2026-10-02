import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { EventEmitter } from "node:events";

const originalFetch = globalThis.fetch;
let initialized = false;

/** Match Pi CLI's environment-proxy bootstrap using the same pinned HTTP library.
 * Importing Undici 8 installs its default dispatcher in Node's legacy slot too,
 * replacing the dispatcher created by NODE_USE_ENV_PROXY. SDK consumers must
 * initialize their dispatcher after imports, just as Pi's own CLI does.
 */
export function initializeProviderNetwork(): void {
  if (initialized) return;
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false, connect: { autoSelectFamilyAttemptTimeout: 2_000 } });
  // Pi also retains stream errors on the request rather than allowing the
  // dispatcher's EventEmitter error event to terminate the host process.
  EventEmitter.prototype.on.call(dispatcher, "error", () => {});
  setGlobalDispatcher(dispatcher);
  // Keep fetch and its dispatcher on the same implementation, but preserve
  // deliberate host/test instrumentation installed after module loading.
  if (globalThis.fetch === originalFetch) install();
  initialized = true;
}
