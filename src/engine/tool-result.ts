/** Model-visible transport. Host annotations never change business fields. */
export type ResultObject = Record<string, unknown>;
export interface ToolNotice { kind: string; text: string; routeId?: string | undefined }
export const isObject = (value: unknown): value is ResultObject => typeof value === "object" && value !== null && !Array.isArray(value);
export function parseToolResult(content: unknown, legacyNotices = false): { value?: ResultObject; text: string; legacy: boolean } {
  const blocks = Array.isArray(content) ? content.filter(isObject).filter(b => b.type === "text" && typeof b.text === "string") : [];
  const text = blocks.map(b => String(b.text)).join("\n");
  const legacy = legacyNotices && blocks.length > 1 && blocks.slice(1).every(b => ["[Structural investigation recommended]\n", "[Structural investigation]\n", "[Impact synthesis checkpoint]\n", "Structural investigation is degraded."].some(prefix => String(b.text).startsWith(prefix)));
  try {
    const value: unknown = JSON.parse(legacy ? String(blocks[0]!.text) : text);
    return { ...(isObject(value) ? { value } : {}), text, legacy };
  } catch { return { text, legacy }; }
}
export function annotateResult(value: ResultObject, notices: ToolNotice[] = []): ResultObject {
  const metadata = isObject(value._mergewarden) ? value._mergewarden : {};
  return { ...value, _mergewarden: { ...metadata, schemaVersion: 1, notices: [...(Array.isArray(metadata.notices) ? metadata.notices : []), ...notices] } };
}
