package robots

import (
	"errors"
	"net/http"
	"sync"
	"time"
)

var (
	// ErrEvidenceExists is returned when an append would overwrite an existing
	// evidence record.
	ErrEvidenceExists = errors.New("robots: evidence already exists")
	// ErrEvidenceIDRequired is returned for evidence without a stable ID.
	ErrEvidenceIDRequired = errors.New("robots: evidence ID is required")
	// ErrEvidenceVersion is returned when evidence claims a different policy
	// version than the claim that produced it.
	ErrEvidenceVersion = errors.New("robots: evidence policy version mismatch")
	// ErrEvidenceScope is returned when evidence is recorded under a different
	// tenant or origin.
	ErrEvidenceScope = errors.New("robots: evidence scope mismatch")
	// ErrRequestNotSent is returned when evidence is completed before the
	// permit was marked as sent.
	ErrRequestNotSent = errors.New("robots: request was not sent")
)

// Evidence is one immutable completed fetch. PolicyVersion records the exact
// rules that authorised the request. Once appended, evidence is never updated
// by the policy engine, even when later policy generations are installed.
type Evidence struct {
	ID               string
	Tenant           string
	Origin           Origin
	Target           string
	UserAgent        string
	PolicyVersion    uint64
	PolicyGeneration uint64
	RequestedAt      time.Time
	CompletedAt      time.Time
	StatusCode       int
	Headers          http.Header
	Body             []byte
	Metadata         map[string]string
}

// Clone deep-copies mutable fields.
func (e Evidence) Clone() Evidence {
	if e.Headers != nil {
		e.Headers = e.Headers.Clone()
	}
	if e.Body != nil {
		e.Body = append([]byte(nil), e.Body...)
	}
	if e.Metadata != nil {
		metadata := make(map[string]string, len(e.Metadata))
		for key, value := range e.Metadata {
			metadata[key] = value
		}
		e.Metadata = metadata
	}
	return e
}

// EvidenceStore is append-only. Implementations must reject an append whose
// ID already exists and must return defensive copies from Get.
type EvidenceStore interface {
	Append(Evidence) error
	Get(id string) (Evidence, bool)
}

// MemoryEvidenceStore is a concurrency-safe in-memory append-only evidence
// store.
type MemoryEvidenceStore struct {
	mu    sync.RWMutex
	byID  map[string]Evidence
	order []string
}

// NewMemoryEvidenceStore creates an empty in-memory store.
func NewMemoryEvidenceStore() *MemoryEvidenceStore {
	return &MemoryEvidenceStore{byID: make(map[string]Evidence)}
}

// Append stores a defensive copy. It never replaces an existing record.
func (s *MemoryEvidenceStore) Append(evidence Evidence) error {
	if evidence.ID == "" {
		return ErrEvidenceIDRequired
	}
	evidence = evidence.Clone()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byID == nil {
		s.byID = make(map[string]Evidence)
	}
	if _, exists := s.byID[evidence.ID]; exists {
		return ErrEvidenceExists
	}
	s.byID[evidence.ID] = evidence
	s.order = append(s.order, evidence.ID)
	return nil
}

// Get returns a defensive copy.
func (s *MemoryEvidenceStore) Get(id string) (Evidence, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	evidence, ok := s.byID[id]
	if !ok {
		return Evidence{}, false
	}
	return evidence.Clone(), true
}

// List returns defensive copies in append order.
func (s *MemoryEvidenceStore) List() []Evidence {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Evidence, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.byID[id].Clone())
	}
	return out
}

// Len returns the number of completed evidence records.
func (s *MemoryEvidenceStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.order)
}
