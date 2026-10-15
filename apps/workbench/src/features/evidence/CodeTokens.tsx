import type { CSSProperties } from 'react';
import type { ThemedTokenWithVariants } from 'shiki/core';

type TokenStyle = CSSProperties & { '--syntax-light': string; '--syntax-dark': string };

export function CodeTokens({ text, tokens }: { text: string; tokens?: ThemedTokenWithVariants[] | undefined }) {
  if (!tokens?.length) return <>{text}</>;
  return <>{tokens.map((token, index) => {
    const style: TokenStyle = {
      '--syntax-light': token.variants.light?.color ?? 'inherit',
      '--syntax-dark': token.variants.dark?.color ?? 'inherit',
    };
    return <span className="syntax-token" key={`${token.offset}-${index}`} style={style}>{token.content}</span>;
  })}</>;
}
