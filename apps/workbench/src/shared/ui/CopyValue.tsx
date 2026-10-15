import { useState } from 'react';
import { shortId } from '../presentation';
import { Icon } from './Icon';

export function CopyValue({ value, label, length = 12 }: { value: string; label: string; length?: number }) {
  const [result, setResult] = useState<{ value: string; status: 'copied' | 'failed' }>();
  const [copying, setCopying] = useState(false);
  const status = result?.value === value ? result.status : undefined;

  async function copy() {
    setCopying(true);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setResult({ value, status: 'copied' });
    } catch {
      setResult({ value, status: 'failed' });
    } finally {
      setCopying(false);
    }
  }

  return (
    <span className="copy-value">
      <code title={value}>{shortId(value, length)}</code>
      <button className="icon-button copy-button" type="button" aria-label={`复制${label}`} title={`复制${label}`} disabled={copying} onClick={() => { void copy(); }}><Icon name={status === 'copied' ? 'check' : 'copy'} size={14} /></button>
      <span className={status === 'failed' ? 'copy-feedback' : 'sr-only'} role="status">{status === 'copied' ? `${label}已复制` : status === 'failed' ? '复制失败，请手动复制' : ''}</span>
    </span>
  );
}
