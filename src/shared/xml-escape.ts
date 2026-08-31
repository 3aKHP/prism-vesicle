/**
 * XML text and attribute escaping for host-rendered model-facing packets.
 * Owner-neutral home for the two helpers shared by the SubAgent result
 * renderer and the background-shell results envelope: `"` is always escaped,
 * so an attribute value can never be terminated early, and text positions
 * escape `<`/`>` so packet content can never synthesize envelope tags.
 */
export function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}
