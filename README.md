# cert-payment-auth

Certificate-chain payment authorization library and CLI. Node.js 22, standard
library only (`node:crypto`, `node:test`). No network access.

## Model

A certificate is an edge in an approval graph: an `issuer` delegates to a
`subject` with a spending cap and a validity window. Each certificate is
Ed25519-signed by its issuer over the canonical (sorted-key) JSON of
`{id, issuer, subject, maxAmount, notBefore, notAfter}`; `id` is the SHA-256
of the canonical unsigned payload.

```json
{
  "id": "sha256-hex",
  "issuer": "alice",
  "subject": "bob",
  "maxAmount": 500,
  "notBefore": "2025-01-01T00:00:00.000Z",
  "notAfter": "2027-01-01T00:00:00.000Z",
  "signature": "base64-ed25519"
}
```

A **trusted root** is created by issuing a self-signed certificate with
`"root": true`. Any other self-signed certificate is rejected with
`SELF_SIGNED_NON_ROOT`.

## CLI

`node cli.js` reads NDJSON commands from stdin and writes one JSON result per
line to stdout. State (keys, certificates, revocation ledger) lives for the
duration of the process.

```json
{"cmd":"issue-cert","issuer":"root","subject":"root","maxAmount":1000000,"notBefore":"...","notAfter":"...","root":true}
{"cmd":"issue-cert","issuer":"root","subject":"alice","maxAmount":500,"notBefore":"...","notAfter":"..."}
{"cmd":"revoke","certId":"<id>","time":"2026-01-01T00:00:00.000Z"}
{"cmd":"restore","revocationId":"rev-1","time":"2026-01-02T00:00:00.000Z"}
{"cmd":"verify-payment","payer":"alice","payee":"shop","amount":100,"time":"2026-01-01T00:00:00.000Z"}
```

`verify-payment` searches every simple chain from a trusted root to the payer
and returns the first one where every hop has `maxAmount >= amount`, covers
`time`, and is not revoked at `time`:

```json
{"ok":true,"authorization":{"payer":"...","payee":"...","amount":100,"time":"...","rootId":"root","chain":[...],"signature":"..."}}
```

The returned chain is **compressed**: the `issuer` field is omitted because it
is implied (the first certificate is issued by `rootId`, each subsequent one
by the previous certificate's `subject`). `signature` is the payer's Ed25519
signature over the whole authorization, so modifying any signed field fails
`verifyAuthorization`.

Errors are reported as `{"ok":false,"error":{"code":"...","message":"..."}}`
with codes: `SELF_SIGNED_NON_ROOT`, `CERT_EXPIRED`, `CERT_NOT_YET_VALID`,
`AMOUNT_EXCEEDED`, `BAD_SIGNATURE`, `UNKNOWN_ROOT`, `CERT_REVOKED`,
`RESTORE_WITHOUT_REVOKE`, `ALREADY_REVOKED`, `UNKNOWN_CERT`,
`UNKNOWN_REVOCATION`, `CERT_EXISTS`, `BROKEN_CHAIN`, `INVALID_*`,
`UNKNOWN_COMMAND`.

## Revocation and restore

`revoke` appends a revocation event (`rev-N`) for a certificate; `restore`
must be paired with a specific open revocation (`revocationId`, or the latest
open one for `certId`) — restoring without a matching revocation fails with
`RESTORE_WITHOUT_REVOKE`, and a paired revocation cannot be restored twice.
Events are time-scoped: a certificate is revoked at time `t` if the latest
event at or before `t` is a revoke.

## Library

```js
import { CertStore } from './index.js';
const store = new CertStore();
store.issueCert({ issuer: 'root', subject: 'root', maxAmount: 1e6, notBefore, notAfter, root: true });
const auth = store.verifyPayment({ payer, payee, amount, time });
store.verifyAuthorization(auth); // throws CertError on any tampering
```

## Tests

```
node --test
```

Covers: multi-level chains, revoke/restore pairing, expiry, tampering of
every signed field, all error codes, CLI end-to-end over NDJSON, and a
cross-check that for random delegation graphs with n <= 7 principals
`verifyPayment` agrees with brute-force enumeration of all simple chains.
