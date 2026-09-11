# Agent Behaviour Drift Sentinel

**Detects when an agent's behaviour quietly changes, by comparing execution traces against a
signed baseline of normal — with dimension-level attribution and a replayable exemplar.**

MIT licensed · zero runtime dependencies · MCP stdio server · TypeScript

## The security problem

A compromised, prompt-injected, or silently regressed agent rarely announces itself. It keeps
answering, keeps calling tools, and keeps looking fine — while its tool mix shifts, its
escalation rate climbs, or its refusal rate collapses. Nothing in the logs is individually
alarming, so nobody looks. The change is only visible as a change: against what this agent used
to do.

## What this product does

It ingests caller-supplied execution traces, establishes a signed durable baseline of normal
behaviour, and reports divergence with a severity, per-dimension attribution, and a replayable
exemplar episode an investigator can read. Scheduled change is suppressed *visibly* — declared
maintenance windows and known change markers are reported as suppressed, never silently
dropped.

### Major capabilities

- **Signed, immutable baselines.** `set_baseline` always creates a new version; prior versions
  remain loadable. A baseline that fails signature verification is refused — `check_drift`
  errors rather than falling back to an unsigned baseline.
- **Dimension-level attribution.** `explain_drift` says which behavioural dimensions moved and
  by how much, and replays the exemplar episode behind the finding.
- **Sample-size honesty.** Below the configured minimum sample, a severity is still emitted but
  capped at `info`, with `confidence: insufficient-sample`.
- **Calibration without silent mutation.** `calibrate` proposes a profile from labelled
  findings; thresholds change only through `apply_calibration`, which mints a new signed
  baseline version.
- **Visible suppression.** Maintenance windows and known change markers are declared, and
  suppressed findings are reported as suppressed.
- **Redaction totality.** Non-allowlisted free-text fields are reduced to a SHA-256 digest on
  ingest; no raw payload appears in profiles, findings, explanations, replays, or errors.

## Install and run

Prerequisites: [Bun](https://bun.sh) 1.1+ (or Node 22+ with a TypeScript loader). No runtime
dependencies to install.

```bash
git clone https://github.com/SweetKenneth/shpbl-drift-sentinel.git
cd shpbl-drift-sentinel
bun install                    # dev types only
bun test                       # conformance suite
bun run scripts/symbol-scan.ts # build-failing forbidden-symbol scan
bun src/mcp-server.ts          # MCP server: newline-delimited JSON-RPC 2.0 on stdin/stdout
```

### MCP configuration

```json
{
  "mcpServers": {
    "drift-sentinel": {
      "command": "bun",
      "args": ["/absolute/path/to/shpbl-drift-sentinel/src/mcp-server.ts"]
    }
  }
}
```

### Tool surface

| Tool | Purpose |
|---|---|
| `ingest_traces` | ingest caller-supplied execution traces, return a `traceSetRef` |
| `set_baseline` | sign and store a behaviour profile as a new baseline version |
| `check_drift` | compare a trace set against a signed baseline |
| `explain_drift` | dimension-level attribution plus replay of the exemplar episode |
| `calibrate` | propose a calibration profile from labelled findings; never mutates thresholds |
| `apply_calibration` | create a new signed baseline version carrying an approved calibration |
| `configure_suppression` | declare maintenance windows and known change markers |

### Worked example

`examples/worked-example.ts` runs the specification's §9 scenario end to end: a clean baseline,
a drifted trace set, the resulting finding, its dimension attribution, and the exemplar replay.

```bash
bun examples/worked-example.ts
```

## Verification results

28 conformance tests, 118 assertions: specification properties P1–P12, every §7 failure mode,
and the MCP JSON-RPC surface. Forbidden-symbol scan covers 10 source files with 0 findings.
Strict typecheck is clean. Runtime dependencies: **zero**.

## Security boundaries

- **Caller-supplied data only.** No log scraping, no discovery, no network egress, ever.
- **Read-only to the agent.** This product cannot stop, throttle, or alter agent behaviour.
- No ambient filesystem writes, no process execution — enforced by a build-failing scan.
- Errors carry a fixed code and a fixed phrase from this package's own vocabulary, never a
  caller-supplied raw value.

See `SECURITY.md` for the full threat model.

## Known limitations

- **An attacker who controls the trace source can hide.** This product detects drift in what it
  is shown; withheld or shaped traces suppress findings. The documented mitigation is pairing
  ingest with a hash-linked evidence ledger for the trace source.
- A finding is a signal for an investigator, not a verdict. It does not attribute the change to
  a human or external actor and does not diagnose root cause.
- Small samples yield low-confidence results by design; severity is capped at `info` rather than
  suppressed, so a thin window is visible instead of silent.

## Provenance

Discovered with SHPBL. This product originated through cross-capability composition in the
SHPBL capability library. Its public implementation was independently built from a published
behavioural specification. SHPBL's proprietary capability library, discovery system, harvested
implementation bodies, and private provenance machinery are not included.

- Public behavioural specification: <https://github.com/SweetKenneth/shpbl-spec-drift-sentinel>
  (a copy ships here as `SPEC-agent-behaviour-drift-sentinel.md`)
- SHPBL: <https://shpbl.com>
- Details: `PROVENANCE.md`

## Tenable status

Submitted to the [Tenable CyberAgents Exchange for review on September 11, 2026](https://github.com/tenable/cyberagents-exchange/pull/167).
Submission does not imply review, approval, certification, validation, endorsement, or acceptance by Tenable.

## SHPBL Agent Evidence series

Independently installable, interoperable at the evidence-record boundary:

- [shpbl-action-ledger](https://github.com/SweetKenneth/shpbl-action-ledger) — agent action evidence ledger
- [shpbl-handoff-attestor](https://github.com/SweetKenneth/shpbl-handoff-attestor) — cross-agent handoff attestation
- [shpbl-drift-sentinel](https://github.com/SweetKenneth/shpbl-drift-sentinel) — agent behaviour drift detection
- [shpbl-retrieval-auditor](https://github.com/SweetKenneth/shpbl-retrieval-auditor) — retrieval context provenance
- [shpbl-canary-chain](https://github.com/SweetKenneth/shpbl-canary-chain) — synthetic canary evidence chain

## Licence

MIT — Copyright (c) 2026 Kenneth E. Sweet Jr. See `LICENSE`.
