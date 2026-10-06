package shardsim

import "sync"

// Action enumerates the controlled behaviours a Scripted callback performs
// for each OnRecord invocation, in script order.
type Action int

const (
	// ActAck acknowledges the record immediately.
	ActAck Action = iota
	// ActDrop declines the record immediately.
	ActDrop
	// ActBlock parks the callback (simulating an in-flight delivery) until
	// Release is called, then acknowledges.
	ActBlock
)

// Scripted is a Callback whose per-call behaviour is enumerated by a script.
// Calls beyond the script length default to ActAck. It records assignment
// and revocation generations so tests can verify ordering.
type Scripted struct {
	mu       sync.Mutex
	script   []Action
	calls    int
	gate     chan struct{}
	assigned []uint64
	revoked  []uint64
	records  []Record
}

// NewScripted returns a Scripted callback running the given action script.
func NewScripted(script ...Action) *Scripted {
	return &Scripted{script: script, gate: make(chan struct{})}
}

// OnAssigned records the granted generation.
func (s *Scripted) OnAssigned(shard int, generation uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.assigned = append(s.assigned, generation)
}

// OnRevoked records the revoked generation.
func (s *Scripted) OnRevoked(shard int, generation uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revoked = append(s.revoked, generation)
}

// OnRecord performs the scripted action for this call index.
func (s *Scripted) OnRecord(shard int, generation uint64, rec Record) bool {
	s.mu.Lock()
	action := ActAck
	if s.calls < len(s.script) {
		action = s.script[s.calls]
	}
	s.calls++
	s.records = append(s.records, rec)
	gate := s.gate
	s.mu.Unlock()

	switch action {
	case ActDrop:
		return false
	case ActBlock:
		<-gate
		return true
	default:
		return true
	}
}

// Release unblocks the current ActBlock call and re-arms the gate for the
// next one.
func (s *Scripted) Release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	close(s.gate)
	s.gate = make(chan struct{})
}

// Calls returns how many OnRecord invocations have started.
func (s *Scripted) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// Assigned returns the granted generations in order.
func (s *Scripted) Assigned() []uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]uint64(nil), s.assigned...)
}

// Revoked returns the revoked generations in order.
func (s *Scripted) Revoked() []uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]uint64(nil), s.revoked...)
}
