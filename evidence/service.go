package evidence

import (
	"errors"
	"sync"
)

// ErrStaleReceipt is returned when an older receipt tries to overwrite a
// newer one.
var ErrStaleReceipt = errors.New("evidence: stale receipt would overwrite newer state")

// Service runs asynchronous verification with a generation guard: each new
// submission bumps the evidence generation, and a late async result from an
// older generation is discarded instead of overwriting newer state.
type Service struct {
	mu     sync.Mutex
	val    *Validator
	states map[string]*State
}

// State is the current verification state for one evidence ID.
type State struct {
	Generation uint64
	Report     Report
	Receipt    *Receipt
}

func NewService(v *Validator) *Service {
	return &Service{val: v, states: make(map[string]*State)}
}

// Submit stores a pending state and starts asynchronous verification. It
// returns the generation the result will be applied under.
func (s *Service) Submit(id string, in Input) uint64 {
	s.mu.Lock()
	gen := uint64(1)
	if st, ok := s.states[id]; ok {
		gen = st.Generation + 1
	}
	s.states[id] = &State{Generation: gen, Report: Report{Status: StatusIncomplete}}
	s.mu.Unlock()

	go func() {
		rep := s.val.Validate(in)
		s.apply(id, gen, rep, in.Receipt)
	}()
	return gen
}

func (s *Service) apply(id string, gen uint64, rep Report, rcpt *Receipt) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok || st.Generation != gen {
		return // late async verification must not overwrite newer state
	}
	st.Report = rep
	st.Receipt = rcpt
}

// ApplyReceipt applies an externally delivered receipt. A receipt that is
// not newer than the stored one is refused so old receipts cannot roll back
// the state.
func (s *Service) ApplyReceipt(id string, rcpt *Receipt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		st = &State{Generation: 1, Report: Report{Status: StatusIncomplete}}
		s.states[id] = st
	}
	if st.Receipt != nil && !rcpt.SignedAt.After(st.Receipt.SignedAt) {
		return ErrStaleReceipt
	}
	st.Receipt = rcpt
	st.Generation++
	return nil
}

// State returns a copy of the current state for an evidence ID.
func (s *Service) State(id string) (State, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		return State{}, false
	}
	return *st, true
}
