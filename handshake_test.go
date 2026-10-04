package handshake

import (
	"errors"
	"testing"
)

func mustRegister(t *testing.T, s *Simulator, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if err := s.Register(id); err != nil {
			t.Fatalf("Register(%q): %v", id, err)
		}
	}
}

func mustState(t *testing.T, s *Simulator, id string, want State) Challenge {
	t.Helper()
	c, ok := s.Challenge(id)
	if !ok {
		t.Fatalf("challenge %q not found", id)
	}
	if c.State != want {
		t.Fatalf("challenge %q state = %v, want %v", id, c.State, want)
	}
	return c
}

func mustRejectReason(t *testing.T, rej []Rejection, kind EventKind, id string, want error) {
	t.Helper()
	for _, r := range rej {
		if r.Event.Kind == kind && r.Event.ChallengeID == id {
			if !errors.Is(r.Reason, want) {
				t.Fatalf("rejection for %v/%q reason = %v, want %v", kind, id, r.Reason, want)
			}
			return
		}
	}
	t.Fatalf("no rejection recorded for %v/%q (rejections: %v)", kind, id, rej)
}

func TestResponseBindsDigest(t *testing.T) {
	s := New()
	mustRegister(t, s, "c1")

	rej := s.ApplyTick([]Event{{ChallengeID: "c1", Kind: EventResponse, Digest: "sha256:abc"}})
	if len(rej) != 0 {
		t.Fatalf("unexpected rejections: %v", rej)
	}
	c := mustState(t, s, "c1", StateVerified)
	if c.Digest != "sha256:abc" {
		t.Fatalf("bound digest = %q, want %q", c.Digest, "sha256:abc")
	}
	if !c.State.Terminal() {
		t.Fatal("verified state must be terminal")
	}
}

func TestVerifyAndTimeoutSameTickInputOrder(t *testing.T) {
	// Response first: verification wins, the timeout is rejected.
	s := New()
	mustRegister(t, s, "c1")
	rej := s.ApplyTick([]Event{
		{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"},
		{ChallengeID: "c1", Kind: EventTimeout},
	})
	mustState(t, s, "c1", StateVerified)
	mustRejectReason(t, rej, EventTimeout, "c1", ErrInvalidEvent)

	// Timeout first: expiry wins, the response is rejected.
	s2 := New()
	mustRegister(t, s2, "c1")
	rej2 := s2.ApplyTick([]Event{
		{ChallengeID: "c1", Kind: EventTimeout},
		{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"},
	})
	mustState(t, s2, "c1", StateExpired)
	mustRejectReason(t, rej2, EventResponse, "c1", ErrInvalidEvent)
}

func TestRevokeBeatsLaterResponseSameTick(t *testing.T) {
	s := New()
	mustRegister(t, s, "c1")
	rej := s.ApplyTick([]Event{
		{ChallengeID: "c1", Kind: EventRevoke},
		{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"},
		{ChallengeID: "c1", Kind: EventTimeout},
	})
	mustState(t, s, "c1", StateRevoked)
	if len(rej) != 2 {
		t.Fatalf("rejections = %v, want 2 entries", rej)
	}
}

func TestTerminalStatePersistentAcrossTicks(t *testing.T) {
	s := New()
	mustRegister(t, s, "c1")
	s.ApplyTick([]Event{{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"}})
	mustState(t, s, "c1", StateVerified)

	// Out-of-order and duplicate events in later ticks must not overwrite.
	rej := s.ApplyTick([]Event{
		{ChallengeID: "c1", Kind: EventTimeout},
		{ChallengeID: "c1", Kind: EventRevoke},
		{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"}, // duplicate
	})
	c := mustState(t, s, "c1", StateVerified)
	if c.Digest != "d1" {
		t.Fatalf("digest overwritten: %q", c.Digest)
	}
	if len(rej) != 3 {
		t.Fatalf("rejections = %v, want 3 entries", rej)
	}
	mustRejectReason(t, rej, EventResponse, "c1", ErrDuplicateEvent)
}

func TestTerminalExpiredAndRevokedPersistent(t *testing.T) {
	s := New()
	mustRegister(t, s, "a", "b")
	s.ApplyTick([]Event{
		{ChallengeID: "a", Kind: EventTimeout},
		{ChallengeID: "b", Kind: EventRevoke},
	})
	rej := s.ApplyTick([]Event{
		{ChallengeID: "a", Kind: EventResponse, Digest: "d"},
		{ChallengeID: "a", Kind: EventRevoke},
		{ChallengeID: "b", Kind: EventResponse, Digest: "d"},
		{ChallengeID: "b", Kind: EventTimeout},
	})
	mustState(t, s, "a", StateExpired)
	mustState(t, s, "b", StateRevoked)
	if len(rej) != 4 {
		t.Fatalf("rejections = %v, want 4 entries", rej)
	}
}

func TestDuplicateResponseDigestMismatch(t *testing.T) {
	s := New()
	mustRegister(t, s, "c1")
	s.ApplyTick([]Event{{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"}})

	// Same digest: harmless duplicate. Different digest: rebind attempt.
	rej := s.ApplyTick([]Event{
		{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"},
		{ChallengeID: "c1", Kind: EventResponse, Digest: "evil"},
	})
	mustRejectReason(t, rej, EventResponse, "c1", ErrDuplicateEvent)
	var sawMismatch bool
	for _, r := range rej {
		if errors.Is(r.Reason, ErrDigestMismatch) && r.Event.Digest == "evil" {
			sawMismatch = true
		}
	}
	if !sawMismatch {
		t.Fatalf("expected ErrDigestMismatch for rebind attempt, got %v", rej)
	}
	mustState(t, s, "c1", StateVerified)
}

func TestUnknownChallengeAndEmptyDigest(t *testing.T) {
	s := New()
	mustRegister(t, s, "c1")
	rej := s.ApplyTick([]Event{
		{ChallengeID: "ghost", Kind: EventResponse, Digest: "d"},
		{ChallengeID: "ghost", Kind: EventTimeout},
		{ChallengeID: "c1", Kind: EventResponse, Digest: ""},
	})
	if len(rej) != 3 {
		t.Fatalf("rejections = %v, want 3 entries", rej)
	}
	mustRejectReason(t, rej, EventResponse, "ghost", ErrUnknownChallenge)
	mustRejectReason(t, rej, EventTimeout, "ghost", ErrUnknownChallenge)
	mustRejectReason(t, rej, EventResponse, "c1", ErrEmptyDigest)
	mustState(t, s, "c1", StatePending) // failed response leaves state untouched
}

func TestDuplicateRegisterRejected(t *testing.T) {
	s := New()
	mustRegister(t, s, "c1")
	if err := s.Register("c1"); !errors.Is(err, ErrChallengeExists) {
		t.Fatalf("re-register err = %v, want %v", err, ErrChallengeExists)
	}
}

func TestIndependentChallengesSameTick(t *testing.T) {
	s := New()
	mustRegister(t, s, "a", "b", "c")
	rej := s.ApplyTick([]Event{
		{ChallengeID: "a", Kind: EventResponse, Digest: "da"},
		{ChallengeID: "b", Kind: EventTimeout},
		{ChallengeID: "c", Kind: EventRevoke},
		{ChallengeID: "a", Kind: EventTimeout}, // loses to a's response above
	})
	mustState(t, s, "a", StateVerified)
	mustState(t, s, "b", StateExpired)
	mustState(t, s, "c", StateRevoked)
	if len(rej) != 1 {
		t.Fatalf("rejections = %v, want 1 entry", rej)
	}
}

// TestTransitionTable pins the finite state table against the spec:
// pending accepts response/timeout/revoke; terminal states accept nothing.
func TestTransitionTable(t *testing.T) {
	states := []State{StatePending, StateVerified, StateExpired, StateRevoked}
	kinds := []EventKind{EventResponse, EventTimeout, EventRevoke}
	want := map[State]map[EventKind]State{
		StatePending: {
			EventResponse: StateVerified,
			EventTimeout:  StateExpired,
			EventRevoke:   StateRevoked,
		},
		StateVerified: {},
		StateExpired:  {},
		StateRevoked:  {},
	}
	for _, st := range states {
		for _, k := range kinds {
			next, ok := transitions[st][k]
			wNext, wOk := want[st][k]
			if ok != wOk || (ok && next != wNext) {
				t.Errorf("transitions[%v][%v] = (%v, %v), want (%v, %v)", st, k, next, ok, wNext, wOk)
			}
			if st.Terminal() && ok {
				t.Errorf("terminal state %v must have no transition for %v", st, k)
			}
		}
	}
}

func TestTickCounterAndHistory(t *testing.T) {
	s := New()
	mustRegister(t, s, "c1")
	if s.Tick() != 0 {
		t.Fatalf("initial tick = %d, want 0", s.Tick())
	}
	s.ApplyTick(nil)
	s.ApplyTick([]Event{{ChallengeID: "c1", Kind: EventResponse, Digest: "d1"}})
	if s.Tick() != 2 {
		t.Fatalf("tick = %d, want 2", s.Tick())
	}
	h := s.History()
	if len(h) != 1 || h[0].Tick != 2 || h[0].From != StatePending || h[0].To != StateVerified {
		t.Fatalf("history = %+v, want one pending->verified entry at tick 2", h)
	}
	// Rejected events must not appear in history.
	s.ApplyTick([]Event{{ChallengeID: "c1", Kind: EventTimeout}})
	if len(s.History()) != 1 {
		t.Fatalf("history grew after rejected event: %+v", s.History())
	}
}
