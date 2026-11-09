import type { LanguageDescriptor, LoadedExtractor } from "./contracts.ts";
import { python } from "./python.ts";
import { typescript } from "./typescript.ts";

/**
 * The language manifest (ADR 0022). Adding a language means adding one descriptor here; nothing is
 * discovered dynamically, so no unknown code is loaded and graph identities stay reproducible.
 * Order matters: it is the stable order of every per-language list.
 */
export const LANGUAGES: readonly LanguageDescriptor[] = Object.freeze([python, typescript]);
/** Languages a run enables when it does not choose. Evaluations pin their own set. */
export const DEFAULT_LANGUAGE_IDS: readonly string[] = Object.freeze(LANGUAGES.map(language => language.id));
export const LEGACY_LANGUAGE_IDS: readonly string[] = Object.freeze(["python"]);

export function language(id: string): LanguageDescriptor {
  const found = LANGUAGES.find(item => item.id === id); if (!found) throw new Error(`Unknown graph language: ${id}`); return found;
}
/** The registered language that owns a path, whether or not a run enables it. */
export function languageForPath(path: string): LanguageDescriptor | undefined { return LANGUAGES.find(item => item.owns(path)); }

/** Validate an enabled set and return it in manifest order. */
export function enabledLanguages(ids: readonly string[] = DEFAULT_LANGUAGE_IDS): LanguageDescriptor[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > LANGUAGES.length || new Set(ids).size !== ids.length) throw new Error("Graph languages must be a non-empty unique list");
  for (const id of ids) language(id);
  return LANGUAGES.filter(item => ids.includes(item.id));
}

/**
 * Enabled languages that own at least one head path. A snapshot without any of them keeps the first
 * enabled language so that its (empty, unsupported) graph keeps a stable identity.
 */
export function effectiveLanguages(ids: readonly string[] | undefined, headPaths: readonly string[]): LanguageDescriptor[] {
  const enabled = enabledLanguages(ids); const present = enabled.filter(item => headPaths.some(path => item.owns(path)));
  return present.length ? present : [enabled[0]!];
}

export function displayNames(languages: readonly LanguageDescriptor[]): string { return languages.map(item => item.displayName).join("/"); }

/** Load a pack's parser half from integrations. Callers own dispose(). */
export async function loadExtractor(descriptor: LanguageDescriptor): Promise<LoadedExtractor> {
  const module = await import(new URL(descriptor.extractor.module, import.meta.url).href) as Record<string, { create(): Promise<LoadedExtractor> }>;
  const factory = module[descriptor.extractor.export]; if (!factory?.create) throw new Error(`Language extractor unavailable: ${descriptor.id}`);
  return factory.create();
}

/** Identity fields of a language set. One language keeps the Graph v4 flat fields. */
export interface LanguageIdentity { ids: string[]; parser: string; resolver: string; policy: string; resolvers: string[] }
export function languageIdentity(languages: readonly LanguageDescriptor[]): LanguageIdentity {
  if (languages.length === 1) { const only = languages[0]!; return { ids: [only.id], parser: only.versions.parser, resolver: only.versions.resolver, policy: only.versions.policy, resolvers: [only.versions.resolver] }; }
  const join = (key: "parser" | "resolver" | "policy") => languages.map(item => `${item.id}:${item.versions[key]}`).join(";");
  return { ids: languages.map(item => item.id), parser: join("parser"), resolver: join("resolver"), policy: join("policy"), resolvers: languages.map(item => item.versions.resolver) };
}
