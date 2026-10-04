package handshake

import "testing"

func mustIssue(t *testing.T, s *Simulator, id, digest string) {
	t.Helper()
	if err := s.Issue(id, digest); err != nil {
		t.Fatalf("Issue(%q): %v", id, err)
	}
}

func mustState(t *testing.T, s *Simulator, id string, want State) {
	t.Helper()
	got, ok := s.State(id)
	if !ok {
		t.Fatalf("State(%q): challenge missing", id)
	}
	if got != want {
		t.Fatalf("State(%q) = %s, want %s", id, got, want)
	}
}

func TestRespondBindsDigest(t *testing.T) {
	s := New()
	mustIssue(t, s, "c1", "digest-1")

	out := s.Apply(Event{Kind: EventRespond, ID: "c1", Digest: "wrong"})
	if out[0] != OutcomeDigestMismatch {
		t.Fatalf("wrong digest outcome = %s, want %s", out[0], OutcomeDigestMismatch)
	}
	mustState(t, s, "c1", StatePending)

	out = s.Apply(Event{Kind: EventRespond, ID: "c1", Digest: "digest-1"})
	if out[0] != OutcomeApplied {
		t.Fatalf("matching digest outcome = %s, want %s", out[0], OutcomeApplied)
	}
	mustState(t, s, "c1", StateVerified)
}

func TestSameTickInputOrder(t *testing.T) {
	// 回应在前、超时在后：回应先生效。
	s := New()
	mustIssue(t, s, "a", "d")
	out := s.Apply(
		Event{Kind: EventRespond, ID: "a", Digest: "d"},
		Event{Kind: EventTimeout, ID: "a"},
	)
	if out[0] != OutcomeApplied || out[1] != OutcomeIgnoredTerminal {
		t.Fatalf("respond-first outcomes = %v, want [applied ignored_terminal]", out)
	}
	mustState(t, s, "a", StateVerified)

	// 超时在前、回应在后：超时先生效。
	s = New()
	mustIssue(t, s, "b", "d")
	out = s.Apply(
		Event{Kind: EventTimeout, ID: "b"},
		Event{Kind: EventRespond, ID: "b", Digest: "d"},
	)
	if out[0] != OutcomeApplied || out[1] != OutcomeIgnoredTerminal {
		t.Fatalf("timeout-first outcomes = %v, want [applied ignored_terminal]", out)
	}
	mustState(t, s, "b", StateTimedOut)
}

func TestTerminalStatesPersist(t *testing.T) {
	terminals := []struct {
		name  string
		event Event
		want  State
	}{
		{"verified", Event{Kind: EventRespond, ID: "x", Digest: "d"}, StateVerified},
		{"timed_out", Event{Kind: EventTimeout, ID: "x"}, StateTimedOut},
		{"revoked", Event{Kind: EventRevoke, ID: "x"}, StateRevoked},
	}
	for _, tc := range terminals {
		t.Run(tc.name, func(t *testing.T) {
			s := New()
			mustIssue(t, s, "x", "d")
			if out := s.Apply(tc.event); out[0] != OutcomeApplied {
				t.Fatalf("setup outcome = %s", out[0])
			}
			// 终态不可被任何后续事件覆盖。
			out := s.Apply(
				Event{Kind: EventRespond, ID: "x", Digest: "d"},
				Event{Kind: EventTimeout, ID: "x"},
				Event{Kind: EventRevoke, ID: "x"},
			)
			for i, o := range out {
				if o != OutcomeIgnoredTerminal {
					t.Fatalf("event %d outcome = %s, want %s", i, o, OutcomeIgnoredTerminal)
				}
			}
			mustState(t, s, "x", tc.want)
			// 终态不可被重新签发覆盖。
			if err := s.Issue("x", "other"); err == nil {
				t.Fatal("re-issue on terminal id succeeded, want error")
			}
			mustState(t, s, "x", tc.want)
		})
	}
}

func TestOutOfOrderDuplicates(t *testing.T) {
	s := New()
	mustIssue(t, s, "c", "d")
	mustIssue(t, s, "z", "d")

	// 乱序：z 的撤销先于 c 的回应；重复：同一事件多次到达。
	out := s.Apply(
		Event{Kind: EventRevoke, ID: "z"},
		Event{Kind: EventRevoke, ID: "z"}, // 重复撤销
		Event{Kind: EventRespond, ID: "c", Digest: "d"},
		Event{Kind: EventRespond, ID: "c", Digest: "d"}, // 重复回应
		Event{Kind: EventTimeout, ID: "c"},              // 迟到超时
		Event{Kind: EventTimeout, ID: "ghost"},          // 未知 ID
	)
	want := []Outcome{
		OutcomeApplied, OutcomeIgnoredTerminal,
		OutcomeApplied, OutcomeIgnoredTerminal,
		OutcomeIgnoredTerminal,
		OutcomeUnknownChallenge,
	}
	for i := range want {
		if out[i] != want[i] {
			t.Fatalf("outcome[%d] = %s, want %s", i, out[i], want[i])
		}
	}
	mustState(t, s, "z", StateRevoked)
	mustState(t, s, "c", StateVerified)

	// 轨迹与输入一一对应，顺序不变。
	log := s.Log()
	if len(log) != len(want) {
		t.Fatalf("log length = %d, want %d", len(log), len(want))
	}
	for i, r := range log {
		if r.Seq != i || r.Outcome != want[i] {
			t.Fatalf("log[%d] = {Seq:%d Outcome:%s}, want {Seq:%d Outcome:%s}",
				i, r.Seq, r.Outcome, i, want[i])
		}
	}
}

func TestStateTable(t *testing.T) {
	// 与有限状态表逐项核对：Pending 的三条出边 + 终态无出边。
	want := map[State]map[EventKind]State{
		StatePending: {
			EventRespond: StateVerified,
			EventTimeout: StateTimedOut,
			EventRevoke:  StateRevoked,
		},
		StateVerified: {},
		StateTimedOut: {},
		StateRevoked:  {},
	}
	states := []State{StatePending, StateVerified, StateTimedOut, StateRevoked}
	kinds := []EventKind{EventRespond, EventTimeout, EventRevoke}
	for _, st := range states {
		if st.Terminal() != (st != StatePending) {
			t.Fatalf("Terminal(%s) = %v", st, st.Terminal())
		}
		for _, k := range kinds {
			gotNext, gotOK := Next(st, k)
			wantNext, wantOK := want[st][k]
			if gotOK != wantOK || (gotOK && gotNext != wantNext) {
				t.Fatalf("Next(%s, %s) = (%s, %v), want (%s, %v)",
					st, k, gotNext, gotOK, wantNext, wantOK)
			}
		}
	}
}

func TestIssueValidation(t *testing.T) {
	s := New()
	if err := s.Issue("", "d"); err != ErrEmptyID {
		t.Fatalf("empty id err = %v, want %v", err, ErrEmptyID)
	}
	mustIssue(t, s, "p", "d")
	if err := s.Issue("p", "d2"); err == nil {
		t.Fatal("duplicate issue on pending id succeeded, want error")
	}
	if _, ok := s.State("missing"); ok {
		t.Fatal("State(missing) found, want not found")
	}
}
