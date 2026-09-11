// Suppression configuration and evaluation. SPEC §3.7, invariant 6, failure mode "conflicting windows".
import { Json, SentinelError, digestOf, requireId, requireTimestamp, sha256 } from "./canonical.js";

export interface MaintenanceWindow {
  id: string;
  timezone: string;
  // Absolute interval, or a minimal weekly-recurrence window (documented subset of cron:
  // day-of-week + hour range only — this package does not implement general cron parsing).
  interval?: { start: string; end: string };
  recurring?: { weekday: number; startHour: number; endHour: number };
}

export interface KnownChangeMarker {
  id: string;
  field: string;
  match: "exact" | "prefix";
  valueDigest: string;
  prefixLength?: number;
}

export interface SuppressionConfig {
  configurationVersion: number;
  changedBy: string;
  changedAt: string;
  maintenanceWindows: MaintenanceWindow[];
  knownChangeMarkers: KnownChangeMarker[];
}

function parseWindow(raw: unknown, pointer: string): MaintenanceWindow {
  const r = raw as Record<string, unknown>;
  const id = requireId(r?.id, `${pointer}/id`);
  const timezone = typeof r?.timezone === "string" ? r.timezone : "UTC";
  const out: MaintenanceWindow = { id, timezone };
  if (r?.interval) {
    const iv = r.interval as Record<string, unknown>;
    out.interval = { start: requireTimestamp(iv.start, `${pointer}/interval/start`), end: requireTimestamp(iv.end, `${pointer}/interval/end`) };
  } else if (r?.recurring) {
    const rc = r.recurring as Record<string, unknown>;
    if (typeof rc.weekday !== "number" || typeof rc.startHour !== "number" || typeof rc.endHour !== "number") {
      throw new SentinelError("E_INPUT", "expected recurring weekday/startHour/endHour", `${pointer}/recurring`);
    }
    out.recurring = { weekday: rc.weekday, startHour: rc.startHour, endHour: rc.endHour };
  } else {
    throw new SentinelError("E_INPUT", "expected interval or recurring window", pointer);
  }
  return out;
}

function parseMarker(raw: unknown, pointer: string): KnownChangeMarker {
  const r = raw as Record<string, unknown>;
  const id = requireId(r?.id, `${pointer}/id`);
  const field = requireId(r?.field, `${pointer}/field`);
  const match = r?.match;
  if (match !== "exact" && match !== "prefix") {
    throw new SentinelError("E_INPUT", "expected match exact|prefix", `${pointer}/match`);
  }
  const valueDigest = r?.valueDigest;
  if (typeof valueDigest !== "string" || valueDigest.length === 0) {
    throw new SentinelError("E_INPUT", "expected valueDigest", `${pointer}/valueDigest`);
  }
  const prefixLength = match === "prefix" ? Number(r?.prefixLength) : undefined;
  if (match === "prefix" && (!Number.isInteger(prefixLength) || (prefixLength as number) <= 0)) {
    throw new SentinelError("E_INPUT", "prefix match requires declared prefixLength", `${pointer}/prefixLength`);
  }
  return { id, field, match, valueDigest, prefixLength };
}

export function parseSuppressionConfig(raw: unknown, previousVersion: number): SuppressionConfig {
  const r = raw as Record<string, unknown>;
  const changedBy = requireId(r?.changedBy, "/changedBy");
  const changedAt = requireTimestamp(r?.changedAt, "/changedAt");
  const maintenanceWindows = Array.isArray(r?.maintenanceWindows)
    ? r.maintenanceWindows.map((w, i) => parseWindow(w, `/maintenanceWindows/${i}`))
    : [];
  const knownChangeMarkers = Array.isArray(r?.knownChangeMarkers)
    ? r.knownChangeMarkers.map((m, i) => parseMarker(m, `/knownChangeMarkers/${i}`))
    : [];
  return { configurationVersion: previousVersion + 1, changedBy, changedAt, maintenanceWindows, knownChangeMarkers };
}

function isoWeekdayAndHourUtc(iso: string): { weekday: number; hour: number } {
  const d = new Date(iso);
  return { weekday: d.getUTCDay(), hour: d.getUTCHours() };
}

export interface SuppressionResult {
  suppressed: boolean;
  configurationVersion: number;
  matchedWindows: string[];
  matchedMarkers: string[];
  changedBy: string;
}

/**
 * Evaluate whether an activity window (windowStart..windowEnd) and any marker field digests
 * are covered by the current suppression configuration. All matches are reported — there is
 * no silent precedence among conflicting windows (SPEC §7).
 */
export function evaluateSuppression(
  config: SuppressionConfig,
  windowStart: string,
  windowEnd: string,
  markerFieldDigests: Record<string, string>,
): SuppressionResult {
  const matchedWindows: string[] = [];
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  for (const w of config.maintenanceWindows) {
    if (w.interval) {
      const s = Date.parse(w.interval.start);
      const e = Date.parse(w.interval.end);
      if (startMs <= e && endMs >= s) matchedWindows.push(w.id);
    } else if (w.recurring) {
      const a = isoWeekdayAndHourUtc(windowStart);
      const b = isoWeekdayAndHourUtc(windowEnd);
      const inRange = (p: { weekday: number; hour: number }) =>
        p.weekday === w.recurring!.weekday && p.hour >= w.recurring!.startHour && p.hour < w.recurring!.endHour;
      if (inRange(a) || inRange(b)) matchedWindows.push(w.id);
    }
  }
  const matchedMarkers: string[] = [];
  for (const m of config.knownChangeMarkers) {
    const observed = markerFieldDigests[m.field];
    if (observed === undefined) continue;
    if (m.match === "exact" && observed === m.valueDigest) matchedMarkers.push(m.id);
    if (m.match === "prefix" && m.prefixLength && observed.slice(0, m.prefixLength) === m.valueDigest.slice(0, m.prefixLength)) {
      matchedMarkers.push(m.id);
    }
  }
  matchedWindows.sort();
  matchedMarkers.sort();
  return {
    suppressed: matchedWindows.length > 0 || matchedMarkers.length > 0,
    configurationVersion: config.configurationVersion,
    matchedWindows,
    matchedMarkers,
    changedBy: config.changedBy,
  };
}

export function markerDigest(value: string): string {
  return sha256(value);
}
