import { useMemo } from 'react';
import type { EvidenceResponse } from '@mergewarden/contracts';
import { useSyntaxTokens } from './useSyntaxTokens';
import { CodeTokens } from './CodeTokens';

export type AvailableSource = EvidenceResponse['source'] & { status: 'ok' };

/** `evidence` marks every line as a cited evidence range; navigation source is shown without that claim. */
export function SourceCodeViewer({ source, evidence = true }: { source: AvailableSource; evidence?: boolean }) {
  const lines = useMemo(() => {
    const values = source.text.split('\n');
    if (values.at(-1) === '' && values.length > source.endLine - source.startLine + 1) values.pop();
    return values;
  }, [source.endLine, source.startLine, source.text]);
  const tokens = useSyntaxTokens(source.path, source.text);

  return (
    <pre className="source-code" aria-label={`${source.path} 第 ${source.startLine} 至 ${source.endLine} 行`}><code>{lines.map((line, offset) => (
      <span className={evidence ? 'source-line is-evidence' : 'source-line'} key={source.startLine + offset} aria-label={`第 ${source.startLine + offset} 行${evidence ? '，证据引用' : ''}`}>
        <span className="source-line-number" aria-hidden="true">{source.startLine + offset}</span>
        <span className="source-line-text"><CodeTokens text={line || ' '} tokens={tokens?.[offset]} /></span>
      </span>
    ))}</code></pre>
  );
}
