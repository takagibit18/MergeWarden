import { useEffect, useState } from 'react';
import type { ThemedTokenWithVariants } from 'shiki/core';
import { highlightCode } from './syntax';

type HighlightedSource = { path: string; code: string; lines: ThemedTokenWithVariants[][] };

export function useSyntaxTokens(path: string, code: string): ThemedTokenWithVariants[][] | null {
  const [highlighted, setHighlighted] = useState<HighlightedSource>();

  useEffect(() => {
    let current = true;
    void highlightCode(path, code).then(lines => {
      if (current && lines) setHighlighted({ path, code, lines });
    });
    return () => { current = false; };
  }, [path, code]);

  return highlighted?.path === path && highlighted.code === code ? highlighted.lines : null;
}
