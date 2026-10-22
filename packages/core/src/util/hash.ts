/**
 * Lowercase hex SHA-256 of bytes or of a UTF-8 string, via the web-standard
 * `crypto.subtle` (works in browsers, Node ≥ 20, Bun, Deno).
 *
 * @example
 * ```ts
 * await sha256Hex("hello"); // "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
 * ```
 */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  // Copy into a fresh ArrayBuffer-backed view (SharedArrayBuffer views are not accepted).
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}
