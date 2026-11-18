package formal

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// The exhaustive checker uses a deliberately tiny configuration language:
// two parts (a and b), a validator that rejects b=BAD, and three candidate
// revisions. It enumerates every legal event sequence up to a fixed depth and
// replays each one against both the real Manager and a naive version table.
//
// A trace is legal when a request is started at most once, and read/ended only
// while active. Every legal prefix can be extended with Apply events, so
// checking all maximal traces also checks every shorter trace.

type eventKind uint8

const (
	startRequest eventKind = iota
	readRequest
	endRequest
	applyCandidate
)

type traceEvent struct {
	kind eventKind
	req  int
	cand int
}

func (e traceEvent) String() string {
	switch e.kind {
	case startRequest:
		return fmt.Sprintf("start(%d)", e.req)
	case readRequest:
		return fmt.Sprintf("read(%d)", e.req)
	case endRequest:
		return fmt.Sprintf("end(%d)", e.req)
	case applyCandidate:
		return fmt.Sprintf("apply(%s)", exhaustiveCandidates[e.cand].name)
	default:
		return "unknown"
	}
}

type candidate struct {
	name  string
	parts []Part
	a     string
	b     string
	valid bool
}

var exhaustiveCandidates = []candidate{
	{
		name:  "v1",
		parts: []Part{{Name: "a", Value: "A1"}, {Name: "b", Value: "B1"}},
		a:     "A1",
		b:     "B1",
		valid: true,
	},
	{
		name:  "v2",
		parts: []Part{{Name: "a", Value: "A2"}, {Name: "b", Value: "B2"}},
		a:     "A2",
		b:     "B2",
		valid: true,
	},
	{
		// The a part is new and valid, the b part is invalid. Publishing even
		// the valid part would expose a mixture of versions.
		name:  "bad-b",
		parts: []Part{{Name: "a", Value: "A3"}, {Name: "b", Value: "BAD"}},
		a:     "A3",
		b:     "BAD",
		valid: false,
	},
}

var exhaustiveInitial = []Part{
	{Name: "a", Value: "A0"},
	{Name: "b", Value: "B0"},
}

func newExhaustiveManager() (*Manager, error) {
	return NewManager(
		exhaustiveInitial,
		WithValidator("b", rejectBadB),
		WithConfigValidator(func(version *Version) error {
			if _, ok := version.Get("a"); !ok {
				return errors.New("missing part a")
			}
			if _, ok := version.Get("b"); !ok {
				return errors.New("missing part b")
			}
			return nil
		}),
	)
}

// naiveRow is one entry in the naive version table. id is the publication
// number a correct implementation must assign to that row.
type naiveRow struct {
	id uint64
	a  string
	b  string
}

// naiveState is the reference implementation: a plain table of versions and a
// current row index. Requests simply remember the row that was current when
// they started. It has no atomics, snapshots, or clever concurrency at all.
type naiveState struct {
	rows    []naiveRow
	current int

	active       []bool
	entry        []int
	entryVersion []*Version
	snapshots    []*Snapshot

	published uint64
	rejected  uint64
}

func newNaiveState(requests int) *naiveState {
	return &naiveState{
		rows:         []naiveRow{{id: 1, a: "A0", b: "B0"}},
		active:       make([]bool, requests),
		entry:        make([]int, requests),
		entryVersion: make([]*Version, requests),
		snapshots:    make([]*Snapshot, requests),
	}
}

func (state *naiveState) apply(c candidate) {
	if !c.valid {
		state.rejected++
		return
	}
	last := state.rows[len(state.rows)-1]
	state.rows = append(state.rows, naiveRow{id: last.id + 1, a: c.a, b: c.b})
	state.current = len(state.rows) - 1
	state.published++
}

func (state *naiveState) activeCount() int {
	count := 0
	for _, active := range state.active {
		if active {
			count++
		}
	}
	return count
}

func checkVersionAgainstRow(version *Version, row naiveRow) error {
	if version == nil {
		return errors.New("nil version")
	}
	if version.ID() != row.id {
		return fmt.Errorf("version ID = %d, want %d", version.ID(), row.id)
	}
	if version.Len() != 2 {
		return fmt.Errorf("version has %d parts, want exactly 2", version.Len())
	}
	a, ok := version.Get("a")
	if !ok {
		return errors.New("version is missing part a")
	}
	if a != row.a {
		return fmt.Errorf("part a = %v, want %s", a, row.a)
	}
	b, ok := version.Get("b")
	if !ok {
		return errors.New("version is missing part b")
	}
	if b != row.b {
		return fmt.Errorf("part b = %v, want %s", b, row.b)
	}
	return nil
}

func runTrace(m *Manager, requests int, trace []traceEvent) error {
	model := newNaiveState(requests)

	for step, event := range trace {
		switch event.kind {
		case startRequest:
			if event.req < 0 || event.req >= requests {
				return fmt.Errorf("step %d: bad request id %d", step, event.req)
			}
			if model.active[event.req] {
				return fmt.Errorf("step %d: request %d started twice", step, event.req)
			}
			snapshot := m.Acquire()
			model.snapshots[event.req] = snapshot
			model.entry[event.req] = model.current
			model.entryVersion[event.req] = snapshot.Version
			model.active[event.req] = true
			if err := checkVersionAgainstRow(snapshot.Version, model.rows[model.current]); err != nil {
				return fmt.Errorf("step %d %s: %w", step, event, err)
			}

		case readRequest:
			if !model.active[event.req] {
				return fmt.Errorf("step %d: request %d read while inactive", step, event.req)
			}
			snapshot := model.snapshots[event.req]
			if snapshot.Version != model.entryVersion[event.req] {
				return fmt.Errorf("step %d %s: request switched from v%d to v%d while in flight",
					step, event, model.entryVersion[event.req].ID(), snapshot.Version.ID())
			}
			if err := checkVersionAgainstRow(snapshot.Version, model.rows[model.entry[event.req]]); err != nil {
				return fmt.Errorf("step %d %s: %w", step, event, err)
			}

		case endRequest:
			if !model.active[event.req] {
				return fmt.Errorf("step %d: request %d ended while inactive", step, event.req)
			}
			model.snapshots[event.req].Release()
			model.snapshots[event.req] = nil
			model.active[event.req] = false

		case applyCandidate:
			c := exhaustiveCandidates[event.cand]
			before := m.Current()
			version, err := m.Apply(c.parts)
			if c.valid {
				if err != nil {
					return fmt.Errorf("step %d %s: valid candidate rejected: %w", step, event, err)
				}
				model.apply(c)
				if err := checkVersionAgainstRow(version, model.rows[model.current]); err != nil {
					return fmt.Errorf("step %d %s: %w", step, event, err)
				}
				if m.Current() != version {
					return fmt.Errorf("step %d %s: Current is not the published candidate", step, event)
				}
			} else {
				if err == nil {
					return fmt.Errorf("step %d %s: invalid candidate was published", step, event)
				}
				var validation *ValidationError
				if !errors.As(err, &validation) {
					return fmt.Errorf("step %d %s: rejection error is %T, want *ValidationError", step, event, err)
				}
				model.apply(c)
				if m.Current() != before {
					return fmt.Errorf("step %d %s: rejected candidate changed Current", step, event)
				}
			}
		}

		if err := checkVersionAgainstRow(m.Current(), model.rows[model.current]); err != nil {
			return fmt.Errorf("step %d %s: after event: %w", step, event, err)
		}
		stats := m.Stats()
		if stats.CurrentVersion != model.rows[model.current].id {
			return fmt.Errorf("step %d %s: Stats.CurrentVersion = %d, want %d",
				step, event, stats.CurrentVersion, model.rows[model.current].id)
		}
		if stats.Published != model.published {
			return fmt.Errorf("step %d %s: Stats.Published = %d, want %d",
				step, event, stats.Published, model.published)
		}
		if stats.Rejected != model.rejected {
			return fmt.Errorf("step %d %s: Stats.Rejected = %d, want %d",
				step, event, stats.Rejected, model.rejected)
		}
		if stats.InFlight != int64(model.activeCount()) {
			return fmt.Errorf("step %d %s: Stats.InFlight = %d, want %d",
				step, event, stats.InFlight, model.activeCount())
		}
		retained := make(map[uint64]struct{})
		for request, active := range model.active {
			if !active {
				continue
			}
			entryID := model.rows[model.entry[request]].id
			if entryID != model.rows[model.current].id {
				retained[entryID] = struct{}{}
			}
		}
		if stats.RetainedVersions != len(retained) {
			return fmt.Errorf("step %d %s: Stats.RetainedVersions = %d, want %d",
				step, event, stats.RetainedVersions, len(retained))
		}
	}
	return nil
}

func legalTraceEvent(event traceEvent, active []bool) bool {
	switch event.kind {
	case startRequest:
		return !active[event.req]
	case readRequest, endRequest:
		return active[event.req]
	case applyCandidate:
		return true
	default:
		return false
	}
}

func formatTrace(trace []traceEvent) string {
	parts := make([]string, len(trace))
	for i, event := range trace {
		parts[i] = event.String()
	}
	return "[" + strings.Join(parts, " -> ") + "]"
}

func enumerateTraces(t *testing.T, requests, depth int) int {
	t.Helper()

	events := make([]traceEvent, 0, 3*requests+len(exhaustiveCandidates))
	for request := 0; request < requests; request++ {
		events = append(events,
			traceEvent{kind: startRequest, req: request},
			traceEvent{kind: readRequest, req: request},
			traceEvent{kind: endRequest, req: request},
		)
	}
	for index := range exhaustiveCandidates {
		events = append(events, traceEvent{kind: applyCandidate, cand: index})
	}

	active := make([]bool, requests)
	trace := make([]traceEvent, 0, depth)
	leaves := 0

	var walk func()
	walk = func() {
		if len(trace) == depth {
			m, err := newExhaustiveManager()
			if err != nil {
				t.Fatalf("NewManager: %v", err)
			}
			if err := runTrace(m, requests, trace); err != nil {
				t.Fatalf("trace %s: %v", formatTrace(trace), err)
			}
			leaves++
			return
		}

		for _, event := range events {
			if !legalTraceEvent(event, active) {
				continue
			}
			trace = append(trace, event)
			switch event.kind {
			case startRequest:
				active[event.req] = true
			case endRequest:
				active[event.req] = false
			}

			walk()

			switch event.kind {
			case startRequest:
				active[event.req] = false
			case endRequest:
				active[event.req] = true
			}
			trace = trace[:len(trace)-1]
		}
	}

	walk()
	return leaves
}

func TestExhaustiveSingleRequestEventSequences(t *testing.T) {
	if testing.Short() {
		t.Skip("exhaustive event enumeration is skipped in -short mode")
	}
	const depth = 9
	leaves := enumerateTraces(t, 1, depth)
	// There are four legal moves while idle (three applies plus start) and
	// five while active (three applies plus read and end).
	if want := 691903; leaves != want {
		t.Fatalf("enumerated %d traces of depth %d, want %d", leaves, depth, want)
	}
	t.Logf("checked %d exhaustive single-request traces", leaves)
}

func TestExhaustiveTwoRequestEventSequences(t *testing.T) {
	if testing.Short() {
		t.Skip("exhaustive event enumeration is skipped in -short mode")
	}
	const depth = 7
	leaves := enumerateTraces(t, 2, depth)
	if want := 198593; leaves != want {
		t.Fatalf("enumerated %d traces of depth %d, want %d", leaves, depth, want)
	}
	t.Logf("checked %d exhaustive two-request traces", leaves)
}
