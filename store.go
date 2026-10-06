package evidencecheck

import (
	"fmt"
	"sync"
)

// Record is the stored state for one problem.
type Record struct {
	Manifest Manifest
	Report   Report
	Receipt  *Receipt
	// Generation increases on every accepted update; async verifications
	// capture it and are dropped when it has moved on.
	Generation int64
}

// Store keeps the latest evidence state per problem. Submitting a newer
// manifest version invalidates older evidence; stale receipts and late
// async verification results never overwrite newer state.
type Store struct {
	mu      sync.Mutex
	records map[string]*Record
}

func NewStore() *Store {
	return &Store{records: make(map[string]*Record)}
}

// Submit validates and records a manifest. A manifest whose version is not
// newer than the stored one is rejected as superseded and does not modify
// state. The (possibly failing) report is returned either way.
func (s *Store) Submit(raw map[string]any, exp Expected) (Report, error) {
	rep, m := ValidateManifest(raw, exp)

	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.records[m.ProblemID]
	if cur != nil && m.Version <= cur.Manifest.Version {
		rep.Status = StatusRejected
		rep.addError(FieldVersion, fmt.Sprintf("version %d superseded by stored version %d; old evidence is invalid", m.Version, cur.Manifest.Version))
		return rep, fmt.Errorf("stale version")
	}
	gen := int64(1)
	if cur != nil {
		gen = cur.Generation + 1
	}
	s.records[m.ProblemID] = &Record{Manifest: m, Report: rep, Generation: gen}
	return rep, nil
}

// Get returns a copy of the current record for a problem.
func (s *Store) Get(problemID string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[problemID]
	if !ok {
		return Record{}, false
	}
	return *r, true
}

// Pending is a handle for an async verification started against a specific
// store generation.
type Pending struct {
	problemID  string
	generation int64
}

// BeginVerify captures the current generation for a problem so a later
// CompleteVerify can detect that newer state arrived meanwhile.
func (s *Store) BeginVerify(problemID string) (Pending, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[problemID]
	if !ok {
		return Pending{}, false
	}
	return Pending{problemID: problemID, generation: r.Generation}, true
}

// CompleteVerify applies an asynchronously produced report only if the
// record has not changed since BeginVerify. It returns false when the
// result arrived too late and was discarded.
func (s *Store) CompleteVerify(p Pending, rep Report) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[p.problemID]
	if !ok || r.Generation != p.generation {
		return false
	}
	r.Report = rep
	return true
}

// ApplyReceipt verifies and attaches a receipt to the current record. The
// receipt must target the stored version and evidence hash, pass signature
// and trust checks, and must not be older than an already attached receipt.
// Old or invalid receipts never overwrite newer state.
func (s *Store) ApplyReceipt(r Receipt, signer Signer, reg *TrustRegistry) (Report, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.records[r.ProblemID]
	if !ok {
		return Report{Status: StatusRejected}, fmt.Errorf("no evidence stored for problem %q", r.ProblemID)
	}
	rep := rec.Report
	if r.Version != rec.Manifest.Version {
		rep.Status = StatusRejected
		rep.addError(FieldVersion, fmt.Sprintf("receipt version %d does not match stored version %d; old receipt rejected", r.Version, rec.Manifest.Version))
		return rep, fmt.Errorf("stale receipt")
	}
	if rec.Receipt != nil && !r.SignedAt.After(rec.Receipt.SignedAt) {
		rep.Status = StatusRejected
		rep.addError("receipt.signed_at", "receipt is not newer than the stored one; old receipt rejected")
		return rep, fmt.Errorf("old receipt")
	}
	expectedHash := ""
	if rec.Manifest.Score != nil {
		expectedHash = ChainHash(rec.Manifest.StatementHash, rec.Manifest.ArtifactHash, *rec.Manifest.Score)
	}
	errs := VerifyReceipt(r, signer, reg, expectedHash)
	if len(errs) > 0 {
		rep.Status = StatusRejected
		rep.Errors = append(rep.Errors, errs...)
		return rep, fmt.Errorf("receipt verification failed")
	}
	rc := r
	rec.Receipt = &rc
	rec.Generation++
	rep.Chain = append(rep.Chain, ChainLink{Stage: "receipt", Hash: r.EvidenceHash, OK: true})
	rec.Report = rep
	return rep, nil
}
