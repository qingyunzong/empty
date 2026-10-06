package evidencecheck

import (
	"fmt"
	"sync"
	"time"
)

// Receipt is a signed attestation binding an evidence (association) hash to
// a problem version, issued by a signer at one of its trust versions.
type Receipt struct {
	ProblemID    string
	Version      int
	EvidenceHash string
	SignerID     string
	TrustVersion int
	SignedAt     time.Time
	Signature    []byte
}

// payload returns the canonical signed bytes.
func (r Receipt) payload() []byte {
	return receiptPayload(r.ProblemID, r.Version, r.EvidenceHash, r.SignedAt.Unix())
}

// SignReceipt issues a receipt for the given evidence hash using the
// adapter's key for (signerID, trustVersion).
func SignReceipt(s Signer, problemID string, version int, evidenceHash, signerID string, trustVersion int, signedAt time.Time) (Receipt, error) {
	r := Receipt{
		ProblemID:    problemID,
		Version:      version,
		EvidenceHash: evidenceHash,
		SignerID:     signerID,
		TrustVersion: trustVersion,
		SignedAt:     signedAt,
	}
	sig, err := s.Sign(signerID, trustVersion, r.payload())
	if err != nil {
		return Receipt{}, err
	}
	r.Signature = sig
	return r, nil
}

// TrustRecord describes one trust version of a signer.
type TrustRecord struct {
	SignerID     string
	TrustVersion int
	// RevokedAt is the moment this trust version was revoked; nil means it
	// is still trusted. Receipts signed before RevokedAt remain valid,
	// receipts signed at or after it are rejected.
	RevokedAt *time.Time
}

// TrustRegistry stores trust records per signer.
type TrustRegistry struct {
	mu      sync.RWMutex
	records map[string]map[int]TrustRecord
}

func NewTrustRegistry() *TrustRegistry {
	return &TrustRegistry{records: make(map[string]map[int]TrustRecord)}
}

// Trust registers (or replaces) a trust version for a signer.
func (t *TrustRegistry) Trust(signerID string, trustVersion int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.records[signerID] == nil {
		t.records[signerID] = make(map[int]TrustRecord)
	}
	t.records[signerID][trustVersion] = TrustRecord{SignerID: signerID, TrustVersion: trustVersion}
}

// Revoke marks a trust version revoked at the given moment.
func (t *TrustRegistry) Revoke(signerID string, trustVersion int, at time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.records[signerID] == nil {
		t.records[signerID] = make(map[int]TrustRecord)
	}
	t.records[signerID][trustVersion] = TrustRecord{SignerID: signerID, TrustVersion: trustVersion, RevokedAt: &at}
}

func (t *TrustRegistry) record(signerID string, trustVersion int) (TrustRecord, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	rec, ok := t.records[signerID][trustVersion]
	return rec, ok
}

// Receipt error locations.
const (
	LocReceiptSignature = "receipt.signature"
	LocReceiptTrust     = "receipt.trust_version"
	LocReceiptRevoked   = "receipt.revoked_at"
	LocReceiptHash      = "receipt.evidence_hash"
)

// VerifyReceipt checks a receipt against the trust registry and the expected
// evidence hash. A receipt is valid only when its signature verifies and its
// signer trust version is registered and not revoked at signing time.
// Every failure is reported with its location and reason.
func VerifyReceipt(r Receipt, s Signer, reg *TrustRegistry, expectedEvidenceHash string) []ValidationError {
	var errs []ValidationError
	if r.EvidenceHash != expectedEvidenceHash {
		errs = append(errs, ValidationError{
			Location: LocReceiptHash,
			Reason:   fmt.Sprintf("evidence hash mismatch: got %s, want %s", r.EvidenceHash, expectedEvidenceHash),
		})
	}
	if !s.Verify(r.SignerID, r.TrustVersion, r.payload(), r.Signature) {
		errs = append(errs, ValidationError{Location: LocReceiptSignature, Reason: "signature verification failed"})
	}
	rec, ok := reg.record(r.SignerID, r.TrustVersion)
	if !ok {
		errs = append(errs, ValidationError{
			Location: LocReceiptTrust,
			Reason:   fmt.Sprintf("signer %q trust version %d is not registered", r.SignerID, r.TrustVersion),
		})
	} else if rec.RevokedAt != nil && !r.SignedAt.Before(*rec.RevokedAt) {
		errs = append(errs, ValidationError{
			Location: LocReceiptRevoked,
			Reason:   fmt.Sprintf("trust version %d revoked at %s, receipt signed at %s", r.TrustVersion, rec.RevokedAt.UTC().Format(time.RFC3339), r.SignedAt.UTC().Format(time.RFC3339)),
		})
	}
	return errs
}
