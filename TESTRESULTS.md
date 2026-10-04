# Test Results

Command: `GOCACHE=/tmp/gocache go test ./... -v -count=1`
(GOCACHE overridden because the default cache dir is read-only in this environment)

Date: 2026-10-05, Go 1.27.1 linux/amd64

Result: **PASS** — 11/11 tests, `ok handshake 0.010s`

| Test | Verifies |
|---|---|
| TestResponseBindsDigest | response binds digest to challenge ID, verified is terminal |
| TestVerifyAndTimeoutSameTickInputOrder | verify+timeout in same tick resolved by input order (both orders) |
| TestRevokeBeatsLaterResponseSameTick | revoke wins when earlier in input; later events rejected |
| TestTerminalStatePersistentAcrossTicks | verified state survives later timeout/revoke/duplicate response |
| TestTerminalExpiredAndRevokedPersistent | expired/revoked states cannot be overwritten |
| TestDuplicateResponseDigestMismatch | same-digest duplicate vs different-digest rebind attempt |
| TestUnknownChallengeAndEmptyDigest | unknown IDs and empty digests rejected, state untouched |
| TestDuplicateRegisterRejected | duplicate challenge ID registration fails |
| TestIndependentChallengesSameTick | per-challenge isolation within one tick |
| TestTransitionTable | FSM table matches spec; terminal states have no transitions |
| TestTickCounterAndHistory | tick counter advances; only applied events enter audit log |
