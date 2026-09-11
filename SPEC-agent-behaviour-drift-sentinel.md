# SPEC — Agent Behaviour Drift Sentinel

Status: **public behaviour specification, version 1.0.** Specification release only.
No implementation, Tenable listing, Exchange submission, PR, or Contribution Agreement
acceptance is authorized by this document.

Product form: MCP server + skill.
Written from product behaviour and capability intent. No harvested body was quoted,
translated, or structurally reproduced in producing this specification.

---

## 1. Purpose

An agent that silently changes how it behaves — escalating privileges, retrying more,
refusing less, calling different tools, growing its step counts — is a real incident
source with no dedicated detector. Existing drift tooling watches *tool surfaces* and
*cloud schemas*; this watches the **agent's own behavioural distribution**.

The product ingests caller-supplied execution traces, establishes a signed durable
baseline of normal behaviour, and reports divergence with an explanation, a severity,
and a replayable episode. Scheduled change (maintenance windows, known release
cadence) is suppressed so it is not reported as drift.

Non-goal: blocking the agent, attributing the cause to an actor, or judging intent.

## 2. Definitions

- **Trace** — one recorded agent episode: a sequence of steps with tool names, outcomes,
  latencies, refusals, token/step counts, and a start timestamp.
- **Behaviour profile** — the aggregated distributional summary of a trace set:
  tool-frequency distribution, outcome mix, refusal rate, latency quantiles, step-count
  quantiles, escalation events, and a set of behavioural fingerprints.
- **Fingerprint** — a SHA-256 digest of the canonical form of a recurring behavioural
  pattern (e.g. an ordered tool sequence), used for identity and dedup, never for security.
- **Baseline** — a named, versioned, signed profile treated as normal.
- **Divergence** — a measured difference between a candidate profile and the baseline.
- **Finding** — a divergence that survives suppression, with severity and explanation.

## 3. Inputs

### 3.1 `ingest_traces`
```
{ "agentId": "planner-1",
  "traces": [
    { "traceId": "t-001",
      "startedAt": "2026-09-11T02:14:00Z",
      "steps": [
        { "tool": "search", "outcome": "success", "latencyMs": 220 },
        { "tool": "shell.exec", "outcome": "refused", "latencyMs": 4,
          "escalation": true }
      ],
      "tokens": { "in": 1840, "out": 260 } } ] }
```
Constraints: caller-supplied traces only. The package never scrapes logs, opens files it
was not handed, or makes a network call. Limits: ≤ 10,000 traces per call, ≤ 4,096 steps
per trace, tool names `^[A-Za-z0-9._:-]{1,128}$`. Free-text fields are digest-reduced on
ingest unless their key is on the redaction allowlist.

### 3.2 `set_baseline`
`{ agentId, name, traceSetRef, keyRef }` → signs and stores the profile.

### 3.3 `check_drift`
`{ agentId, baselineName, traceSetRef, now?, profileRef? }`

### 3.4 `explain_drift`
`{ findingId }` → dimension-level attribution plus the replay of the most divergent episode.

### 3.5 `calibrate`
`{ agentId, labelledFindings: [{ findingId, label: "true" | "false" }] }` → returns a
calibration profile; never silently mutates thresholds. Applying a calibration profile is
an explicit separate call.

### 3.6 `apply_calibration`
`{ agentId, baselineName, baselineVersion, calibrationProfileRef, keyRef }` → creates a
new signed baseline version carrying the approved threshold profile. The prior baseline
version remains immutable and loadable.

### 3.7 Suppression configuration
`{ maintenanceWindows: [{ id, cron | interval, timezone }],
  knownChangeMarkers: [{ id, field, match: "exact" | "prefix", valueDigest }],
  configurationVersion, changedBy, changedAt }`
Windows are operator-declared. The package may *learn* a recurring activity profile from
history and offer it as a proposed window, but never applies a learned window without
explicit acceptance. Marker matching uses canonical field values reduced to SHA-256: `exact`
requires digest equality; `prefix` applies only to normalized non-secret identifiers and
requires a declared prefix length. Every suppression result identifies the configuration
version, matching window or marker id, and change attribution.

## 4. Outputs

### 4.1 Profile
```
{ "agentId": "planner-1", "traceCount": 812, "windowStart": "…", "windowEnd": "…",
  "toolMix": { "search": 0.61, "doc.write": 0.30, "shell.exec": 0.09 },
  "outcomeMix": { "success": 0.88, "failure": 0.06, "refused": 0.06 },
  "refusalRate": 0.06,
  "latencyMs": { "p50": 210, "p90": 940, "p99": 3100 },
  "steps": { "p50": 6, "p90": 14, "p99": 31 },
  "escalationRate": 0.004,
  "fingerprints": { "distinct": 47, "top": [ { "digest": "9f2c…", "share": 0.22 } ] },
  "profileDigest": "c30d…" }
```

### 4.2 Finding
```
{ "findingId": "f-014", "agentId": "planner-1", "baselineName": "sept-normal",
  "severity": "high",
  "dimensions": [
    { "name": "escalationRate", "baseline": 0.004, "observed": 0.071,
      "direction": "increase", "contribution": 0.58 },
    { "name": "toolMix.shell.exec", "baseline": 0.09, "observed": 0.34,
      "direction": "increase", "contribution": 0.31 } ],
  "novelFingerprints": [ "4b81…" ],
  "orderAnomaly": false,
  "suppressed": false,
  "exemplarTraceId": "t-3187",
  "confidence": "sufficient-sample" }
```
`severity` ∈ `info`, `low`, `medium`, `high`. `confidence` ∈ `insufficient-sample`,
`sufficient-sample`. `severity` is never reported above `info` when
`confidence = insufficient-sample`.

### 4.3 Explanation and replay
Ordered dimension contributions summing to 1.0, plus a step-by-step reconstruction of
the exemplar episode with the same redaction rules as ingest.

## 5. Invariants

1. **Caller-supplied data only.** No discovery, scraping, or egress. Ever.
2. **Baseline immutability.** A stored baseline is never modified in place. A new baseline
   is a new version with its own signature; the previous version remains loadable.
3. **Signature-checked load.** A baseline that fails signature verification is refused, and
   `check_drift` returns an error rather than falling back to an unsigned baseline.
4. **Determinism.** Same traces + same baseline + same configuration + same seed ⇒
   byte-identical profile digest and identical findings.
5. **Explainability.** Every finding carries dimension-level attribution; a finding with no
   attributable dimension is not emitted.
6. **Suppression is visible.** Suppressed divergences are still returned with
   `suppressed: true` and the matching window named. Suppression never deletes evidence.
7. **Sample-size honesty.** Below the configured minimum sample, the product reports
   `confidence: insufficient-sample` and still emits `severity`, capped at `info`; a severity
   above `info` is never emitted at insufficient sample size.
8. **Redaction totality.** No non-allowlisted raw payload appears in profiles, findings,
   explanations, replays, errors, or logs.
9. **Fingerprints are not secrets and not security controls**; they are collision-resistant
   identifiers only.
10. **Read-only to the agent.** The product cannot stop, throttle, or alter agent behaviour.

## 6. State transitions

```
NO_BASELINE --set_baseline--> BASELINE(v1, signed)
BASELINE(vN) --set_baseline--> BASELINE(vN+1)      (vN retained)
BASELINE --check_drift--> CLEAN | DRIFT_SUPPRESSED | DRIFT_REPORTED
DRIFT_REPORTED --calibrate(labels)--> CALIBRATION_PROPOSED
CALIBRATION_PROPOSED --apply_calibration--> BASELINE(vN+1, signed thresholds; vN retained)
BASELINE(signature invalid) --check_drift--> ERROR (never CLEAN)
```

## 7. Failure modes

| Condition | Behaviour |
|---|---|
| Trace missing required field | `E_INPUT` naming the pointer; whole call rejected, no partial ingest |
| Trace count below minimum sample | profile produced, findings capped at `info`, `insufficient-sample` |
| Baseline not found | `E_NOT_FOUND` |
| Baseline signature invalid or key unavailable | `E_BASELINE_UNTRUSTED`; no comparison performed |
| Conflicting maintenance windows | both reported in the suppression record; no silent precedence |
| Calibration labels contradictory | `E_CALIBRATION` with the conflicting finding ids |
| Trace timestamps out of order | accepted, flagged `orderAnomaly: true` |

## 8. Security boundaries

**In scope:** compromised or poisoned agents, prompt-injection-induced behaviour change,
unnoticed model or configuration regressions, and quiet privilege escalation.

**Out of scope:** attribution to a human or external actor, prevention, and root-cause
diagnosis. A finding is a signal for an investigator, not a verdict.

**Adversarial limit, stated plainly:** an attacker who controls the trace source can
suppress a finding by withholding or shaping traces. The product detects drift in what it
is shown. Pairing ingest with the Agent Action Evidence Ledger — so the trace source is
itself hash-linked — is the documented mitigation.

**Refused capabilities:** log scraping, outbound calls, agent control, storing raw prompt
or response payloads.

## 9. Worked example

Baseline `sept-normal`: 812 traces, `shell.exec` share 0.09, escalation rate 0.004,
refusal rate 0.06.

A configuration change lands. The next 240 traces show `shell.exec` at 0.34 and escalation
at 0.071, with three previously unseen tool-sequence fingerprints.

`check_drift` returns finding `f-014`, severity `high`, with escalation contributing 0.58
and the tool-mix shift 0.31. The change occurred at 02:10 UTC, outside the declared
Sunday 03:00–05:00 maintenance window, so it is not suppressed. `explain_drift` replays
trace `t-3187`, showing an unattested handoff followed by three `shell.exec` attempts.
The operator may record the finding digest in an Agent Action Evidence Ledger.

## 10. Externally testable properties

| ID | Property |
|---|---|
| P1 | Seeded synthetic drift fixtures produce the expected finding at the expected severity. |
| P2 | Traces drawn from the baseline distribution produce no finding above `info` (false-positive suite). |
| P3 | Activity inside a declared maintenance window is returned as `suppressed: true`, never silently dropped. |
| P4 | Any modification of a stored baseline makes `check_drift` fail with `E_BASELINE_UNTRUSTED`. |
| P5 | Identical input twice ⇒ identical `profileDigest` and identical finding ids. |
| P6 | Dimension contributions in every finding sum to 1.0 ± 1e-9. |
| P7 | For traces seeded with secret-shaped payloads, no raw value appears in any output. |
| P8 | Below the configured minimum sample, no severity above `info` is ever emitted. |
| P9 | A static scan of the published build finds no network, process-spawn, or ambient filesystem-read symbol. |
| P10 | Calibration changes thresholds only after an explicit apply call that creates a new signed baseline version. |
| P11 | Replays obey the ingest redaction invariant; seeded raw payloads never occur in replay output. |
| P12 | Every suppressed finding names the suppression configuration version and matching rule id. |
