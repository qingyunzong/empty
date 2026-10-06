package evidence

import (
	"strings"
	"testing"
	"time"
)

var testKey = []byte("test-key")

func intPtr(v int) *int { return &v }

type fixture struct {
	adapter *HMACAdapter
	trust   *TrustStore
	val     *Validator
	input   Input
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	adapter := NewHMACAdapter(map[string][]byte{"signer-a": testKey})
	trust := NewTrustStore()
	m := &Manifest{
		ID:           "ev-1",
		Version:      2,
		ProblemHash:  HashBytes("problem", []byte("problem statement v2")),
		ArtifactHash: HashBytes("artifact", []byte("run artifact v2")),
		Score:        intPtr(4),
	}
	signedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	sig, err := adapter.Sign("signer-a", []byte(m.Digest()))
	if err != nil {
		t.Fatal(err)
	}
	rcpt := &Receipt{
		ManifestID:   m.ID,
		Version:      m.Version,
		Digest:       m.Digest(),
		Signer:       "signer-a",
		TrustVersion: 3,
		SignedAt:     signedAt,
		Signature:    sig,
	}
	return fixture{
		adapter: adapter,
		trust:   trust,
		val:     NewValidator(adapter, trust),
		input: Input{
			ExpectedVersion:      2,
			ExpectedProblemHash:  m.ProblemHash,
			ExpectedArtifactHash: m.ArtifactHash,
			Manifest:             m,
			Receipt:              rcpt,
			Now:                  signedAt.Add(time.Hour),
		},
	}
}

func rejectionAt(rep Report, pos string) *Rejection {
	for i := range rep.Rejections {
		if rep.Rejections[i].Position == pos {
			return &rep.Rejections[i]
		}
	}
	return nil
}

func TestValidEvidence(t *testing.T) {
	f := newFixture(t)
	rep := f.val.Validate(f.input)
	if rep.Status != StatusValid {
		t.Fatalf("status = %s, want valid; rejections: %+v", rep.Status, rep.Rejections)
	}
	wantChain := []string{"version", "problem_hash", "artifact_hash", "score", "receipt"}
	if len(rep.Chain) != len(wantChain) {
		t.Fatalf("chain length = %d, want %d (%+v)", len(rep.Chain), len(wantChain), rep.Chain)
	}
	for i, name := range wantChain {
		if rep.Chain[i].Name != name || rep.Chain[i].Status != StatusValid {
			t.Errorf("chain[%d] = %+v, want valid %q", i, rep.Chain[i], name)
		}
	}
}

func TestScoreMustBeIntegerOneToFive(t *testing.T) {
	for score := MinScore; score <= MaxScore; score++ {
		f := newFixture(t)
		f.input.Manifest.Score = intPtr(score)
		f.input.Manifest.Conclusion = ""
		// re-sign because the digest changed
		m := f.input.Manifest
		sig, err := f.adapter.Sign("signer-a", []byte(m.Digest()))
		if err != nil {
			t.Fatal(err)
		}
		f.input.Receipt.Digest = m.Digest()
		f.input.Receipt.Signature = sig
		if rep := f.val.Validate(f.input); rep.Status != StatusValid {
			t.Errorf("score %d: status = %s, want valid (%+v)", score, rep.Status, rep.Rejections)
		}
	}
	for _, score := range []int{0, 6, -1, 100} {
		f := newFixture(t)
		f.input.Manifest.Score = intPtr(score)
		rep := f.val.Validate(f.input)
		if rep.Status != StatusRejected {
			t.Errorf("score %d: status = %s, want rejected", score, rep.Status)
		}
		if r := rejectionAt(rep, "score"); r == nil {
			t.Errorf("score %d: no rejection at position score: %+v", score, rep.Rejections)
		}
	}
}

func TestMissingEvidenceIsIncomplete(t *testing.T) {
	f := newFixture(t)
	f.input.Manifest.Score = nil
	f.input.Manifest.ProblemHash = ""
	f.input.Receipt = nil
	rep := f.val.Validate(f.input)
	if rep.Status != StatusIncomplete {
		t.Fatalf("status = %s, want incomplete", rep.Status)
	}
	for _, pos := range []string{"score", "problem_hash", "receipt"} {
		if rejectionAt(rep, pos) == nil {
			t.Errorf("expected rejection at %q, got %+v", pos, rep.Rejections)
		}
	}
}

func TestMissingManifestIsIncomplete(t *testing.T) {
	f := newFixture(t)
	f.input.Manifest = nil
	f.input.Receipt = nil
	rep := f.val.Validate(f.input)
	if rep.Status != StatusIncomplete {
		t.Fatalf("status = %s, want incomplete", rep.Status)
	}
	if rejectionAt(rep, "manifest") == nil {
		t.Fatalf("expected rejection at manifest, got %+v", rep.Rejections)
	}
}

func TestValidatorNeverAutoFillsConclusion(t *testing.T) {
	f := newFixture(t)
	f.input.Manifest.Conclusion = ""
	f.input.Manifest.Score = nil
	m := f.input.Manifest
	sig, err := f.adapter.Sign("signer-a", []byte(m.Digest()))
	if err != nil {
		t.Fatal(err)
	}
	f.input.Receipt.Digest = m.Digest()
	f.input.Receipt.Signature = sig
	rep := f.val.Validate(f.input)
	if rep.Status != StatusIncomplete {
		t.Fatalf("status = %s, want incomplete", rep.Status)
	}
	if f.input.Manifest.Conclusion != "" {
		t.Fatalf("validator auto-filled conclusion: %q", f.input.Manifest.Conclusion)
	}
	if f.input.Manifest.Score != nil {
		t.Fatalf("validator auto-filled score: %d", *f.input.Manifest.Score)
	}
}

func TestVersionUpdateInvalidatesOldEvidence(t *testing.T) {
	f := newFixture(t)
	f.input.ExpectedVersion = 3 // version bumped: old v2 evidence must fail
	rep := f.val.Validate(f.input)
	if rep.Status != StatusRejected {
		t.Fatalf("status = %s, want rejected", rep.Status)
	}
	r := rejectionAt(rep, "version")
	if r == nil || !strings.Contains(r.Reason, "stale") {
		t.Fatalf("expected stale-version rejection at version, got %+v", rep.Rejections)
	}
}

func TestHashMismatchRejectedAtPosition(t *testing.T) {
	f := newFixture(t)
	f.input.Manifest.ProblemHash = HashBytes("problem", []byte("tampered"))
	rep := f.val.Validate(f.input)
	if rep.Status != StatusRejected {
		t.Fatalf("status = %s, want rejected", rep.Status)
	}
	if rejectionAt(rep, "problem_hash") == nil {
		t.Fatalf("expected rejection at problem_hash, got %+v", rep.Rejections)
	}
}

func TestReceiptSignatureAndTrust(t *testing.T) {
	t.Run("bad signature rejected", func(t *testing.T) {
		f := newFixture(t)
		f.input.Receipt.Signature = []byte("forged")
		rep := f.val.Validate(f.input)
		if rep.Status != StatusRejected || rejectionAt(rep, "receipt.signature") == nil {
			t.Fatalf("status=%s rejections=%+v, want rejection at receipt.signature", rep.Status, rep.Rejections)
		}
	})
	t.Run("revoked trust version rejected", func(t *testing.T) {
		f := newFixture(t)
		// revoked before the receipt was signed
		f.trust.Revoke("signer-a", 3, f.input.Receipt.SignedAt.Add(-time.Minute))
		rep := f.val.Validate(f.input)
		if rep.Status != StatusRejected || rejectionAt(rep, "receipt.trust_version") == nil {
			t.Fatalf("status=%s rejections=%+v, want rejection at receipt.trust_version", rep.Status, rep.Rejections)
		}
	})
	t.Run("signed before revocation stays valid", func(t *testing.T) {
		f := newFixture(t)
		// revoked after the receipt was signed
		f.trust.Revoke("signer-a", 3, f.input.Receipt.SignedAt.Add(time.Minute))
		rep := f.val.Validate(f.input)
		if rep.Status != StatusValid {
			t.Fatalf("status=%s rejections=%+v, want valid", rep.Status, rep.Rejections)
		}
	})
	t.Run("other trust version unaffected", func(t *testing.T) {
		f := newFixture(t)
		f.trust.Revoke("signer-a", 2, f.input.Receipt.SignedAt.Add(-time.Minute))
		if rep := f.val.Validate(f.input); rep.Status != StatusValid {
			t.Fatalf("status=%s, want valid", rep.Status)
		}
	})
	t.Run("receipt bound to old version rejected", func(t *testing.T) {
		f := newFixture(t)
		f.input.Receipt.Version = 1
		rep := f.val.Validate(f.input)
		if rep.Status != StatusRejected || rejectionAt(rep, "receipt.version") == nil {
			t.Fatalf("status=%s rejections=%+v, want rejection at receipt.version", rep.Status, rep.Rejections)
		}
	})
}

func TestControlledAdapterCanForceFailure(t *testing.T) {
	c := &ControlledAdapter{VerifyFn: func(string, []byte, []byte) error { return ErrBadSignature }}
	f := newFixture(t)
	f.val = NewValidator(c, f.trust)
	rep := f.val.Validate(f.input)
	if rep.Status != StatusRejected || rejectionAt(rep, "receipt.signature") == nil {
		t.Fatalf("status=%s, want rejection at receipt.signature", rep.Status)
	}
	if c.VerifyCalls != 1 {
		t.Fatalf("VerifyCalls = %d, want 1", c.VerifyCalls)
	}
}
