# Provenance

Discovered with SHPBL. This product originated through cross-capability composition in the
SHPBL capability library. Its public implementation was independently built from a published
behavioural specification. SHPBL's proprietary capability library, discovery system, harvested
implementation bodies, and private provenance machinery are not included.

- The invention was published first as a public behaviour specification
  (`SPEC-agent-behaviour-drift-sentinel`, v1.0),
  <https://github.com/SweetKenneth/shpbl-spec-drift-sentinel>.
- This implementation was written fresh from that specification. No harvested SHPBL or CMPSBL
  capability body was quoted, translated, or structurally reproduced.
- The divergence-scoring, severity-assignment, and suppression layers are implemented from the
  specification's properties P1–P12 and §7 failure-mode table only, with this package's own
  published constants (`DEFAULT_THRESHOLDS` in `src/baseline.ts`). No private weighting
  constant, curve, or threshold vocabulary was consulted or reproduced, and verification never
  compares output to a private reference implementation.
- Digest computation is SHA-256 only. No short or non-cryptographic hash is used anywhere.
- No third-party code is vendored. Runtime dependencies: none.
- Author of every file in this tree: Kenneth E. Sweet Jr.

## Release gates, cleared in order

1. conformance tests passing;
2. an exact-file IP surface review of every file that ships;
3. an explicit MIT implementation grant naming that exact reviewed file set;
4. licence file, release manifest and publication.

## Scope of the licence grant

The MIT grant in `LICENSE` covers the released files of this repository only. It is not a grant
over SHPBL, CMPSBL, the SHPBL capability library, harvested capability bodies, discovery
machinery, the Governor, private provenance records, or any other private system or future
product.

Tenable Exchange submission and Contribution Agreement acceptance are separate decisions and
have not been made.
