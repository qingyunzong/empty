package formal

import "time"

type breakerState struct {
	policy           Policy
	window           sampleWindow
	state            State
	generation       uint64
	openedAt         time.Time
	probesInFlight   int
	successfulProbes int
}

func newBreakerState(policy Policy) breakerState {
	return breakerState{
		policy: policy,
		window: newSampleWindow(policy.Window, policy.Buckets),
		state:  StateClosed,
	}
}

func (s *breakerState) advance(now time.Time) {
	if s.state != StateOpen {
		return
	}
	if now.Before(s.openedAt.Add(s.policy.OpenTimeout)) {
		return
	}
	s.state = StateHalfOpen
	s.generation++
	s.probesInFlight = 0
	s.successfulProbes = 0
}

func (s *breakerState) probeCapacityAvailable() bool {
	return s.state != StateHalfOpen ||
		s.probesInFlight < s.policy.HalfOpenMaxConcurrent
}

func (s *breakerState) startProbe() {
	if s.state == StateHalfOpen {
		s.probesInFlight++
	}
}

func (s *breakerState) finish(now time.Time, generation uint64, result Result) {
	if generation != s.generation {
		return
	}
	if result.Latency < 0 {
		result.Latency = 0
	}
	slow := result.Latency >= s.policy.SlowThreshold

	switch s.state {
	case StateClosed:
		s.window.record(now, result.Failed, slow)
		if s.shouldOpen(now) {
			s.open(now)
		}
	case StateHalfOpen:
		if s.probesInFlight > 0 {
			s.probesInFlight--
		}
		if result.Failed || slow {
			s.open(now)
			return
		}
		s.successfulProbes++
		if s.successfulProbes >= s.policy.HalfOpenSuccesses {
			s.close()
		}
	case StateOpen:
		// Late results from the previous generation are ignored.
	}
}

func (s *breakerState) cancelProbe(generation uint64) {
	if generation != s.generation || s.state != StateHalfOpen {
		return
	}
	if s.probesInFlight > 0 {
		s.probesInFlight--
	}
}

func (s *breakerState) shouldOpen(now time.Time) bool {
	counts := s.window.snapshot(now)
	if counts.total < s.policy.MinRequests {
		return false
	}
	total := float64(counts.total)
	return float64(counts.failures)/total >= s.policy.FailureRate ||
		float64(counts.slows)/total >= s.policy.SlowRate
}

func (s *breakerState) open(now time.Time) {
	s.state = StateOpen
	s.generation++
	s.openedAt = now
	s.probesInFlight = 0
	s.successfulProbes = 0
}

func (s *breakerState) close() {
	s.state = StateClosed
	s.generation++
	s.probesInFlight = 0
	s.successfulProbes = 0
	s.window.reset()
}

func (s *breakerState) snapshot(now time.Time) Snapshot {
	s.advance(now)
	counts := s.window.snapshot(now)
	snapshot := Snapshot{
		State:     s.state,
		Total:     counts.total,
		Failures:  counts.failures,
		SlowCalls: counts.slows,
	}
	if counts.total > 0 {
		snapshot.FailureRate = float64(counts.failures) / float64(counts.total)
		snapshot.SlowRate = float64(counts.slows) / float64(counts.total)
	}
	return snapshot
}
