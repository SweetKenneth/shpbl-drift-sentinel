// Redaction: every free-text field not on the fixed schema is reduced to a SHA-256 digest
// on ingest, unless its key is on the redaction allowlist (SPEC 3.1, invariant 8).
import { Json, sha256 } from "./canonical.js";

/** Structured, non-secret keys that are safe to keep in normalized form. */
export const REDACTION_ALLOWLIST = new Set<string>(["tool", "outcome", "changeMarker"]);

export function digestField(value: Json): string {
  return sha256(typeof value === "string" ? value : JSON.stringify(value));
}

/** Reduce every key not in `keep` to `<key>Digest`; values in `keep` pass through unchanged. */
export function redactExtra(raw: Record<string, unknown>, fixedKeys: Set<string>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const key of Object.keys(raw).sort()) {
    if (fixedKeys.has(key)) continue;
    const value = raw[key];
    if (REDACTION_ALLOWLIST.has(key) && typeof value === "string") {
      out[key] = value.trim().toLowerCase();
    } else {
      out[`${key}Digest`] = digestField(value as Json);
    }
  }
  return out;
}
