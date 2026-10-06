package evidencecheck

import (
	"testing"
	"time"
)

func rawWithVersion(exp Expected, problemID string, version int, score int) map[string]any {
	return map[string]any{
		"problem_id":     problemID,
		"version":        float64(version),
		"statement_hash": exp.StatementHash,
		"artifact_hash":  exp.ArtifactHash,
		"score":          float64(score),
	}
}

func TestVersionUpdateInvalidatesOldEvidence(t *testing.T) {
	exp := testExpected()
	s := NewStore()
	if _, err := s.Submit(rawWithVersion(exp, "p-1", 2, 4), exp); err != nil {
		t.Fatal(err)
	}
	rep, err := s.Submit(rawWithVersion(exp, "p-1", 1, 5), exp)
	if err == nil {
		t.Fatal("stale version accepted")
	}
	if rep.Status != StatusRejected || errAt(rep, FieldVersion) == nil {
		t.Fatalf("stale submit: status=%s errors=%v", rep.Status, rep.Errors)
	}
	rec, _ := s.Get("p-1")
	if rec.Manifest.Version != 2 || *rec.Manifest.Score != 4 {
		t.Fatalf("stored state overwritten by old evidence: %+v", rec.Manifest)
	}
}

func TestLateAsyncVerifyDoesNotOverwrite(t *testing.T) {
	exp := testExpected()
	s := NewStore()
	if _, err := s.Submit(rawWithVersion(exp, "p-1", 1, 3), exp); err != nil {
		t.Fatal(err)
	}
	pending, ok := s.BeginVerify("p-1")
	if !ok {
		t.Fatal("no record")
	}
	// Newer state arrives while verification is in flight.
	if _, err := s.Submit(rawWithVersion(exp, "p-1", 2, 5), exp); err != nil {
		t.Fatal(err)
	}
	late := Report{Status: StatusRejected}
	late.addError(FieldScore, "stale async failure")
	if s.CompleteVerify(pending, late) {
		t.Fatal("late async verification overwrote newer state")
	}
	rec, _ := s.Get("p-1")
	if rec.Report.Status != StatusValid {
		t.Fatalf("state clobbered by late result: %s", rec.Report.Status)
	}
	// A verification started against current state still applies.
	pending2, _ := s.BeginVerify("p-1")
	if !s.CompleteVerify(pending2, Report{Status: StatusValid}) {
		t.Fatal("current verification should apply")
	}
}

func TestOldReceiptDoesNotOverwrite(t *testing.T) {
	exp := testExpected()
	adapter, reg := setupTrust(t)
	s := NewStore()
	if _, err := s.Submit(rawWithVersion(exp, "p-1", 2, 4), exp); err != nil {
		t.Fatal(err)
	}
	hashV2 := ChainHash(exp.StatementHash, exp.ArtifactHash, 4)
	now := time.Now()

	// Receipt for an old version: rejected, state untouched.
	oldVer, _ := SignReceipt(adapter, "p-1", 1, ChainHash(exp.StatementHash, exp.ArtifactHash, 5), "signer-a", 1, now)
	if _, err := s.ApplyReceipt(oldVer, adapter, reg); err == nil {
		t.Fatal("old-version receipt accepted")
	}

	// Valid receipt attaches and extends the chain.
	good, _ := SignReceipt(adapter, "p-1", 2, hashV2, "signer-a", 2, now)
	rep, err := s.ApplyReceipt(good, adapter, reg)
	if err != nil {
		t.Fatalf("valid receipt rejected: %v", err)
	}
	last := rep.Chain[len(rep.Chain)-1]
	if last.Stage != "receipt" || !last.OK {
		t.Fatalf("receipt chain link missing: %+v", rep.Chain)
	}

	// An older-signed receipt must not replace the stored one.
	stale, _ := SignReceipt(adapter, "p-1", 2, hashV2, "signer-a", 1, now.Add(-time.Hour))
	if _, err := s.ApplyReceipt(stale, adapter, reg); err == nil {
		t.Fatal("older receipt overwrote newer one")
	}
	rec, _ := s.Get("p-1")
	if rec.Receipt == nil || rec.Receipt.TrustVersion != 2 {
		t.Fatalf("stored receipt clobbered: %+v", rec.Receipt)
	}
}

func TestRevokedSignerReceiptRejectedAtStore(t *testing.T) {
	exp := testExpected()
	adapter, reg := setupTrust(t)
	s := NewStore()
	if _, err := s.Submit(rawWithVersion(exp, "p-1", 1, 4), exp); err != nil {
		t.Fatal(err)
	}
	hash := ChainHash(exp.StatementHash, exp.ArtifactHash, 4)
	revokedAt := time.Now()
	reg.Revoke("signer-a", 1, revokedAt)
	r, _ := SignReceipt(adapter, "p-1", 1, hash, "signer-a", 1, revokedAt.Add(time.Minute))
	rep, err := s.ApplyReceipt(r, adapter, reg)
	if err == nil {
		t.Fatal("revoked-signer receipt accepted")
	}
	if !hasErrAt(rep.Errors, LocReceiptRevoked) {
		t.Fatalf("expected revocation error, got %v", rep.Errors)
	}
	rec, _ := s.Get("p-1")
	if rec.Receipt != nil {
		t.Fatal("rejected receipt was stored")
	}
}
