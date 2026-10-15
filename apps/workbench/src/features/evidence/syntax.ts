import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { ThemedTokenWithVariants } from 'shiki/core';

const languages = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  makefile: () => import('@shikijs/langs/makefile'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} as const;

type Language = keyof typeof languages;

const languageByExtension: Record<string, Language> = {
  bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', cxx: 'cpp', css: 'css', diff: 'diff', dockerfile: 'docker', go: 'go', h: 'c', hpp: 'cpp',
  html: 'html', htm: 'html', java: 'java', js: 'javascript', jsx: 'jsx', json: 'json', jsonc: 'jsonc', md: 'markdown', mdx: 'markdown',
  makefile: 'makefile', mjs: 'javascript', py: 'python', pyi: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', sql: 'sql', toml: 'toml', ts: 'typescript', tsx: 'tsx', xml: 'xml', yml: 'yaml', yaml: 'yaml',
};

const highlighter = createSingletonShorthands(createBundledHighlighter({
  langs: languages,
  themes: {
    'github-dark-default': () => import('@shikijs/themes/github-dark-default'),
    'github-light-default': () => import('@shikijs/themes/github-light-default'),
  },
  engine: () => createJavaScriptRegexEngine(),
}));

export function languageForPath(path: string): Language | undefined {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'docker';
  if (name === 'makefile') return 'makefile';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return languageByExtension[extension];
}

export async function highlightCode(path: string, code: string): Promise<ThemedTokenWithVariants[][] | null> {
  const lang = languageForPath(path);
  if (!lang || !code) return null;
  try {
    return await highlighter.codeToTokensWithThemes(code, {
      lang,
      themes: { light: 'github-light-default', dark: 'github-dark-default' },
    });
  } catch {
    return null;
  }
}
