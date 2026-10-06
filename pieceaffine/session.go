package pieceaffine

// Session is a pausable, resumable layered preimage computation. The
// number of emitted result intervals is charged against a caller-supplied
// budget; when the budget runs out the session can be paused, serialized
// (it is plain JSON-compatible data) and resumed later.
type Session struct {
	Layers   []Map       `json:"layers"`
	Version  uint64      `json:"version"`
	Layer    int         `json:"layer"`   // layer currently being inverted
	Cur      []Interval  `json:"cur"`     // full target set of the current layer
	Pending  []Interval  `json:"pending"` // targets not yet processed at the current layer
	Done     []Interval  `json:"done"`    // preimage intervals emitted at the current layer
	Steps    []ProofStep `json:"steps"`   // completed per-layer proof steps
	Result   []Interval  `json:"result"`
	Finished bool        `json:"finished"`
}

// NewSession starts a preimage session for y over the chain's layers,
// pinned to the chain's current version.
func NewSession(c *Chain, y Interval) *Session {
	s := &Session{
		Layers:  append([]Map(nil), c.Layers...),
		Version: c.Version,
		Layer:   len(c.Layers) - 1,
		Cur:     Canonical([]Interval{y}),
	}
	s.Pending = append([]Interval(nil), s.Cur...)
	if len(s.Layers) == 0 {
		s.Result = s.Cur
		s.Finished = true
	}
	return s
}

// Step advances the computation until the budget of emitted result
// intervals is exhausted or the computation finishes. Each processed
// target interval charges the size of its per-layer preimage against the
// budget. Step is idempotent on a finished session.
func (s *Session) Step(budget int) {
	for !s.Finished {
		if len(s.Pending) == 0 {
			s.finishLayer()
			continue
		}
		if budget <= 0 {
			return
		}
		iv := s.Pending[0]
		s.Pending = s.Pending[1:]
		pre := s.Layers[s.Layer].Preimage(iv)
		s.Done = append(s.Done, pre...)
		budget -= len(pre)
	}
}

// finishLayer seals the current layer, records its proof step and moves
// the computation one layer up (toward the chain input).
func (s *Session) finishLayer() {
	input := Canonical(s.Done)
	s.Steps = append(s.Steps, ProofStep{Layer: s.Layer, Output: s.Cur, Input: input})
	s.Layer--
	s.Cur = input
	s.Pending = append([]Interval(nil), input...)
	s.Done = nil
	if s.Layer < 0 {
		s.Result = s.Cur
		s.Finished = true
	}
}

// Proof converts a finished session into a Proof. The second return value
// is false while the session is still running.
func (s *Session) Proof() (Proof, bool) {
	if !s.Finished {
		return Proof{}, false
	}
	return Proof{Version: s.Version, Steps: s.Steps, Result: s.Result}, true
}
