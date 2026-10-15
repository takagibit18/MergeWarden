const PREFIX = 'f_';
const MAX_ID_LENGTH = 4000;
const MAX_SEGMENT_LENGTH = 32005;

function assertFindingId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH) {
    throw new Error('Invalid finding identifier');
  }
}

/** Opaque segments prevent URL dot-segment normalization from changing native IDs. */
export function encodeFindingId(id: string): string {
  assertFindingId(id);
  // JSON preserves native IDs containing otherwise lossy UTF-16 surrogate values.
  const bytes = new TextEncoder().encode(JSON.stringify(id));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeFindingId(segment: string): string {
  if (segment.length > MAX_SEGMENT_LENGTH || !/^f_[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('Invalid finding identifier segment');
  }
  try {
    const binary = atob(segment.slice(PREFIX.length).replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertFindingId(value);
    if (encodeFindingId(value) !== segment) throw new Error();
    return value;
  } catch {
    throw new Error('Invalid finding identifier segment');
  }
}
