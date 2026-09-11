// Canonical form + hashing. SHA-256 only; no other digest is produced anywhere in this
// package, and this file is the single point where hashing happens.
import { createHash, timingSafeEqual } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export const TOOL_NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_TRACES_PER_CALL = 10_000;
export const MAX_STEPS_PER_TRACE = 4_096;

/** Deterministic canonical JSON: object keys sorted, fixed numeric precision, no whitespace. */
export function canonical(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SentinelError("E_INPUT", "non-finite number");
    return JSON.stringify(Number(value.toFixed(12)));
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k]!)).join(",") + "}";
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function digestOf(value: Json): string {
  return sha256(canonical(value));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export type ErrorCode =
  | "E_INPUT"
  | "E_NOT_FOUND"
  | "E_BASELINE_UNTRUSTED"
  | "E_CALIBRATION";

/**
 * Errors never carry caller-supplied raw values. `detail` is a fixed vocabulary phrase
 * chosen by this package, never interpolated from input (invariant 8).
 */
export class SentinelError extends Error {
  readonly code: ErrorCode;
  readonly pointer: string;
  readonly data: Json;
  constructor(code: ErrorCode, detail: string, pointer = "", data: Json = null) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.pointer = pointer;
    this.data = data;
    this.name = "SentinelError";
  }
  toJSON() {
    return { error: this.code, detail: this.message.slice(this.code.length + 2), pointer: this.pointer, data: this.data };
  }
}

export function requireId(value: unknown, pointer: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new SentinelError("E_INPUT", "expected identifier", pointer);
  }
  return value;
}

export function requireTimestamp(value: unknown, pointer: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SentinelError("E_INPUT", "expected ISO-8601 timestamp", pointer);
  }
  return new Date(value).toISOString();
}

export function round(n: number, dp = 6): number {
  return Number(n.toFixed(dp));
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp01(q) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
