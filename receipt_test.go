package evidencecheck

import (
	"testing"
	"time"
)

func setupTrust(t *testing.T) (*KeyedAdapter, *TrustRegistry) {
	t.Helper()
	adapter := NewKeyedAdapter()
	adapter.SetKey("signer-a", 1, []byte("key-a-v1"))
	adapter.SetKey("signer-a", 2, []byte("key-a-v2"))
	reg := NewTrustRegistry()
	reg.Trust("signer-a", 1)
	reg.Trust("signer-a", 2)
	return adapter, reg
}

func hasErrAt(errs []ValidationError, location string) bool {
	for _, e := range errs {
		if e.Location == location {
			return true
		}
	}
	return false
}

func TestReceiptValid(t *testing.T) {
	adapter, reg := setupTrust(t)
	hash := ChainHash("s", "a", 3)
	r, err := SignReceipt(adapter, "p-1", 1, hash, "signer-a", 2, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if errs := VerifyReceipt(r, adapter, reg, hash); len(errs) != 0 {
		t.Fatalf("valid receipt rejected: %v", errs)
	}
}

func TestReceiptBadSignature(t *testing.T) {
	adapter, reg := setupTrust(t)
	hash := ChainHash("s", "a", 3)
	r, _ := SignReceipt(adapter, "p-1", 1, hash, "signer-a", 1, time.Now())
	r.Signature[0] ^= 0xff
	if errs := VerifyReceipt(r, adapter, reg, hash); !hasErrAt(errs, LocReceiptSignature) {
		t.Fatalf("expected signature error, got %v", errs)
	}
}

func TestReceiptUnknownTrustVersion(t *testing.T) {
	adapter, reg := setupTrust(t)
	adapter.SetKey("signer-a", 3, []byte("key-a-v3"))
	hash := ChainHash("s", "a", 3)
	r, _ := SignReceipt(adapter, "p-1", 1, hash, "signer-a", 3, time.Now())
	if errs := VerifyReceipt(r, adapter, reg, hash); !hasErrAt(errs, LocReceiptTrust) {
		t.Fatalf("expected trust version error, got %v", errs)
	}
}

func TestReceiptRevocationMoment(t *testing.T) {
	adapter, reg := setupTrust(t)
	hash := ChainHash("s", "a", 3)
	revokedAt := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	reg.Revoke("signer-a", 1, revokedAt)

	// Signed before the revocation moment: still valid.
	before, _ := SignReceipt(adapter, "p-1", 1, hash, "signer-a", 1, revokedAt.Add(-time.Hour))
	if errs := VerifyReceipt(before, adapter, reg, hash); len(errs) != 0 {
		t.Fatalf("receipt signed before revocation should stay valid: %v", errs)
	}
	// Signed at/after the revocation moment: rejected.
	after, _ := SignReceipt(adapter, "p-1", 1, hash, "signer-a", 1, revokedAt.Add(time.Hour))
	if errs := VerifyReceipt(after, adapter, reg, hash); !hasErrAt(errs, LocReceiptRevoked) {
		t.Fatalf("expected revocation error, got %v", errs)
	}
}

func TestReceiptEvidenceHashMismatch(t *testing.T) {
	adapter, reg := setupTrust(t)
	r, _ := SignReceipt(adapter, "p-1", 1, ChainHash("s", "a", 3), "signer-a", 1, time.Now())
	if errs := VerifyReceipt(r, adapter, reg, ChainHash("s", "a", 4)); !hasErrAt(errs, LocReceiptHash) {
		t.Fatalf("expected evidence hash error, got %v", errs)
	}
}
