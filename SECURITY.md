# Security policy and threat model

## In scope

- compromised or poisoned agents
- prompt-injection-induced behaviour change
- unnoticed model or configuration regressions
- quiet privilege escalation, expressed as a shift in tool mix, escalation rate, or refusal
  rate against a signed baseline

## Out of scope

Attribution to a human or external actor, prevention, and root-cause diagnosis. A finding is a
signal for an investigator, not a verdict.

## Adversarial limit, stated plainly

An attacker who controls the trace source can suppress a finding by withholding or shaping
traces. This product detects drift in what it is shown. Pairing ingest with a hash-linked
evidence ledger for the trace source is the documented mitigation.

## Refused capabilities

Log scraping, outbound network calls, filesystem writes, process execution, and agent control
(stopping, throttling, or altering agent behaviour). Enforced by `scripts/symbol-scan.ts`,
which fails the build on any such symbol or a foreign closure reference. Raw prompt and
response payloads are never stored.

## Data handling

Caller-supplied traces only. Non-allowlisted free-text fields are reduced to a SHA-256 digest
on ingest. Errors carry a fixed code and a fixed phrase from this package's own vocabulary,
never a caller-supplied raw value.

## Misuse boundary

This observes the operator's own agent systems from traces the operator supplies. It cannot
discover, reach, or observe a third-party system, and it holds no raw content that could be
repurposed for surveillance.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or contact the maintainer directly. Please
do not open a public issue for a suspected vulnerability before it has been triaged.
