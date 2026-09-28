import { createEventBus, createExtensionRuntime } from '@earendil-works/pi-coding-agent';
import type { ExtensionFactory, ResourceLoader } from '@earendil-works/pi-coding-agent';
// Pi 0.84.1 exposes ResourceLoader but omits this inline-factory helper from its
// package root. Keep the pinned SDK dependency in one adapter; never patch it.
import { loadExtensionFromFactory } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

/** Review has only host-owned extensions. No ancestor/home/package discovery,
 * repository instructions, skills, templates or filesystem prompt overrides. */
export async function reviewResources(options: { cwd: string; systemPrompt: string; extensionFactories: ExtensionFactory[] }): Promise<ResourceLoader> {
  const runtime = createExtensionRuntime(), bus = createEventBus();
  const extensions: Awaited<ReturnType<typeof loadExtensionFromFactory>>[] = [];
  for (const [index, factory] of options.extensionFactories.entries())
    extensions.push(await loadExtensionFromFactory(factory, options.cwd, bus, runtime, `<inline:${index + 1}>`));
  return {
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources(paths) { if (Object.values(paths).some(value => value?.length)) throw Error('Review resources are fixed by the host'); },
    async reload() { /* Host factories and prompt are immutable for this session. */ },
  };
}
