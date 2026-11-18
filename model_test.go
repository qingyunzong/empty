package formal

import (
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"
)

// naiveTable is the reference membership table. It deliberately recomputes
// ranks from scratch by sorting the live member IDs, independently of the
// coordinator's incremental state.
func naiveTable(alive map[MemberID]struct{}) []Member {
	ids := make([]string, 0, len(alive))
	for id := range alive {
		ids = append(ids, string(id))
	}
	sort.Strings(ids)

	table := make([]Member, len(ids))
	for i, id := range ids {
		table[i] = Member{ID: MemberID(id), Rank: Rank(i)}
	}
	return table
}

func containsMember(members []Member, id MemberID) bool {
	for _, member := range members {
		if member.ID == id {
			return true
		}
	}
	return false
}

type naiveGeneration struct {
	number        uint64
	state         GenerationState
	abortReason   AbortReason
	openedAt      time.Time
	deadline      time.Time
	members       []Member
	confirmations map[MemberID]time.Time
}

func (g *naiveGeneration) snapshot() Generation {
	confirmations := make([]Confirmation, 0, len(g.confirmations))
	for member, at := range g.confirmations {
		confirmations = append(confirmations, Confirmation{Member: member, At: at})
	}
	sort.Slice(confirmations, func(i, j int) bool {
		return confirmations[i].Member < confirmations[j].Member
	})

	return Generation{
		Number:        g.number,
		State:         g.state,
		AbortReason:   g.abortReason,
		OpenedAt:      g.openedAt,
		Deadline:      g.deadline,
		Members:       append([]Member(nil), g.members...),
		Confirmations: confirmations,
	}
}

// naiveModel is an independently written reference implementation of the
// protocol. It intentionally keeps a plain sorted table rather than reusing
// any coordinator code.
type naiveModel struct {
	timeout time.Duration

	hasTime bool
	now     time.Time

	lastGen uint64
	alive   map[MemberID]struct{}
	ever    map[MemberID]struct{}
	current *naiveGeneration
	history []*naiveGeneration
}

func newNaiveModel(timeout time.Duration) *naiveModel {
	return &naiveModel{
		timeout: timeout,
		alive:   make(map[MemberID]struct{}),
		ever:    make(map[MemberID]struct{}),
	}
}

func (m *naiveModel) observe(now time.Time) time.Time {
	if !m.hasTime || now.After(m.now) {
		m.now = now
		m.hasTime = true
	}
	return m.now
}

func (m *naiveModel) expire(now time.Time) {
	if m.current == nil || m.current.state != GenerationPending || now.Before(m.current.deadline) {
		return
	}

	survivors := make(map[MemberID]struct{})
	for id := range m.current.confirmations {
		if containsMember(m.current.members, id) {
			survivors[id] = struct{}{}
		}
	}
	m.current.state = GenerationAborted
	m.current.abortReason = AbortDeadline
	m.current = nil
	m.alive = survivors
}

func (m *naiveModel) open(now time.Time, pendingAbort AbortReason) {
	if m.current != nil && m.current.state == GenerationPending {
		m.current.state = GenerationAborted
		m.current.abortReason = pendingAbort
		m.current = nil
	}
	if len(m.alive) == 0 {
		m.current = nil
		return
	}

	m.lastGen++
	generation := &naiveGeneration{
		number:        m.lastGen,
		state:         GenerationPending,
		openedAt:      now,
		deadline:      now.Add(m.timeout),
		members:       naiveTable(m.alive),
		confirmations: make(map[MemberID]time.Time),
	}
	m.current = generation
	m.history = append(m.history, generation)
}

func (m *naiveModel) ensure(now time.Time) {
	if m.current == nil && len(m.alive) > 0 {
		m.open(now, AbortSuperseded)
	}
}

func (m *naiveModel) join(id MemberID, now time.Time) error {
	now = m.observe(now)
	m.expire(now)
	m.ever[id] = struct{}{}

	if _, live := m.alive[id]; live {
		m.ensure(now)
		return nil
	}
	m.alive[id] = struct{}{}
	m.open(now, AbortSuperseded)
	return nil
}

func (m *naiveModel) reconnect(id MemberID, now time.Time) error {
	now = m.observe(now)
	m.expire(now)
	defer m.ensure(now)

	if _, live := m.alive[id]; live {
		return nil
	}
	if _, known := m.ever[id]; !known {
		return fmt.Errorf("%w: %q", ErrUnknownMember, id)
	}
	m.alive[id] = struct{}{}
	m.open(now, AbortSuperseded)
	return nil
}

func (m *naiveModel) fail(id MemberID, now time.Time) error {
	now = m.observe(now)
	m.expire(now)
	defer m.ensure(now)

	if _, live := m.alive[id]; !live {
		if _, known := m.ever[id]; known {
			return nil
		}
		return fmt.Errorf("%w: %q", ErrUnknownMember, id)
	}
	delete(m.alive, id)
	m.open(now, AbortMemberFailed)
	return nil
}

func (m *naiveModel) ack(id MemberID, generation uint64, now time.Time) error {
	now = m.observe(now)
	m.expire(now)
	err := m.ackNoExpire(id, generation, now)
	m.ensure(now)
	return err
}

func (m *naiveModel) ackNoExpire(id MemberID, generation uint64, now time.Time) error {
	if m.current == nil {
		if m.lastGen == 0 {
			return ErrNoGeneration
		}
		if generation <= m.lastGen {
			return fmt.Errorf("%w: generation %d is closed", ErrStaleGeneration, generation)
		}
		return fmt.Errorf("%w: generation %d", ErrUnknownGeneration, generation)
	}

	current := m.current
	if generation < current.number {
		return fmt.Errorf("%w: generation %d, current %d", ErrStaleGeneration, generation, current.number)
	}
	if generation > current.number {
		return fmt.Errorf("%w: generation %d, current %d", ErrUnknownGeneration, generation, current.number)
	}
	if !containsMember(current.members, id) {
		return fmt.Errorf("%w: %q in generation %d", ErrNotMember, id, generation)
	}
	if _, confirmed := current.confirmations[id]; confirmed {
		return nil
	}
	if current.state != GenerationPending {
		return fmt.Errorf("%w: generation %d is %s", ErrGenerationClosed, generation, current.state)
	}

	current.confirmations[id] = now
	if len(current.confirmations) == len(current.members) {
		current.state = GenerationCommitted
	}
	return nil
}

func (m *naiveModel) advance(now time.Time) {
	now = m.observe(now)
	m.expire(now)
	m.ensure(now)
}

func (m *naiveModel) ackTarget() uint64 {
	if m.current != nil {
		return m.current.number
	}
	return m.lastGen
}

func (m *naiveModel) currentSnapshot() (Generation, bool) {
	if m.current == nil {
		return Generation{}, false
	}
	return m.current.snapshot(), true
}

func (m *naiveModel) historySnapshots() []Generation {
	out := make([]Generation, len(m.history))
	for i, generation := range m.history {
		out[i] = generation.snapshot()
	}
	return out
}

func compareGeneration(t *testing.T, label string, got, want Generation) {
	t.Helper()

	if err := got.Validate(); err != nil {
		t.Fatalf("%s: coordinator generation is invalid: %v", label, err)
	}
	if got.Number != want.Number {
		t.Fatalf("%s: number %d, want %d", label, got.Number, want.Number)
	}
	if got.State != want.State {
		t.Fatalf("%s: state %s, want %s", label, got.State, want.State)
	}
	if got.AbortReason != want.AbortReason {
		t.Fatalf("%s: abort reason %s, want %s", label, got.AbortReason, want.AbortReason)
	}
	if !got.OpenedAt.Equal(want.OpenedAt) {
		t.Fatalf("%s: opened at %s, want %s", label, got.OpenedAt, want.OpenedAt)
	}
	if !got.Deadline.Equal(want.Deadline) {
		t.Fatalf("%s: deadline %s, want %s", label, got.Deadline, want.Deadline)
	}
	if len(got.Members) != len(want.Members) {
		t.Fatalf("%s: %d members, want %d", label, len(got.Members), len(want.Members))
	}
	for i := range got.Members {
		if got.Members[i] != want.Members[i] {
			t.Fatalf("%s: member[%d] %+v, want %+v", label, i, got.Members[i], want.Members[i])
		}
	}
	if len(got.Confirmations) != len(want.Confirmations) {
		t.Fatalf("%s: %d confirmations, want %d", label, len(got.Confirmations), len(want.Confirmations))
	}
	for i := range got.Confirmations {
		if got.Confirmations[i].Member != want.Confirmations[i].Member {
			t.Fatalf("%s: confirmation[%d] from %q, want %q",
				label, i, got.Confirmations[i].Member, want.Confirmations[i].Member)
		}
		if !got.Confirmations[i].At.Equal(want.Confirmations[i].At) {
			t.Fatalf("%s: confirmation[%d] at %s, want %s",
				label, i, got.Confirmations[i].At, want.Confirmations[i].At)
		}
	}
}

func compareCoordinatorToModel(t *testing.T, label string, coordinator *Coordinator, model *naiveModel) {
	t.Helper()

	gotCurrent, gotOK := coordinator.Current()
	wantCurrent, wantOK := model.currentSnapshot()
	if gotOK != wantOK {
		t.Fatalf("%s: current present = %v, want %v", label, gotOK, wantOK)
	}
	if gotOK {
		compareGeneration(t, label+" current", gotCurrent, wantCurrent)
	}

	live := coordinator.Members()
	if gotOK != (len(live) > 0) {
		t.Fatalf("%s: current present = %v with %d live members", label, gotOK, len(live))
	}
	if gotOK {
		if len(gotCurrent.Members) != len(live) {
			t.Fatalf("%s: %d live members but current generation has %d",
				label, len(live), len(gotCurrent.Members))
		}
		for i, member := range gotCurrent.Members {
			if member.ID != live[i] {
				t.Fatalf("%s: live member[%d] %q, current generation has %q",
					label, i, live[i], member.ID)
			}
		}
	}

	gotHistory := coordinator.History()
	wantHistory := model.historySnapshots()
	if len(gotHistory) != len(wantHistory) {
		t.Fatalf("%s: history length %d, want %d", label, len(gotHistory), len(wantHistory))
	}
	for i := range gotHistory {
		compareGeneration(t, fmt.Sprintf("%s history[%d]", label, i), gotHistory[i], wantHistory[i])
	}
}

func compareErrors(t *testing.T, label string, got, want error) {
	t.Helper()

	if (got == nil) != (want == nil) {
		t.Fatalf("%s: error %v, want %v", label, got, want)
	}
	sentinels := []error{
		ErrInvalidConfig,
		ErrInvalidMember,
		ErrUnknownMember,
		ErrNoGeneration,
		ErrStaleGeneration,
		ErrUnknownGeneration,
		ErrNotMember,
		ErrGenerationClosed,
		ErrInvalidGeneration,
	}
	for _, sentinel := range sentinels {
		if errors.Is(got, sentinel) != errors.Is(want, sentinel) {
			t.Fatalf("%s: error %v, want %v", label, got, want)
		}
	}
}

type traceOpKind uint8

const (
	opJoin traceOpKind = iota
	opReconnect
	opFail
	opAck
	opAdvance
)

type traceOp struct {
	kind   traceOpKind
	member MemberID
	dt     time.Duration
}

func (op traceOp) String() string {
	switch op.kind {
	case opJoin:
		return fmt.Sprintf("join(%s)+%s", op.member, op.dt)
	case opReconnect:
		return fmt.Sprintf("reconnect(%s)+%s", op.member, op.dt)
	case opFail:
		return fmt.Sprintf("fail(%s)+%s", op.member, op.dt)
	case opAck:
		return fmt.Sprintf("ack(%s)+%s", op.member, op.dt)
	case opAdvance:
		return fmt.Sprintf("advance+%s", op.dt)
	default:
		return "unknown"
	}
}

func applyCoordinator(coordinator *Coordinator, op traceOp, generation uint64, now time.Time) error {
	switch op.kind {
	case opJoin:
		return coordinator.Join(op.member, now)
	case opReconnect:
		return coordinator.Reconnect(op.member, now)
	case opFail:
		return coordinator.Fail(op.member, now)
	case opAck:
		return coordinator.Ack(op.member, generation, now)
	case opAdvance:
		coordinator.Advance(now)
		return nil
	default:
		panic("unreachable")
	}
}

func applyModel(model *naiveModel, op traceOp, generation uint64, now time.Time) error {
	switch op.kind {
	case opJoin:
		return model.join(op.member, now)
	case opReconnect:
		return model.reconnect(op.member, now)
	case opFail:
		return model.fail(op.member, now)
	case opAck:
		return model.ack(op.member, generation, now)
	case opAdvance:
		model.advance(now)
		return nil
	default:
		panic("unreachable")
	}
}

func enumerateTraces(ops []traceOp, depth int, visit func([]traceOp)) {
	trace := make([]traceOp, 0, depth)
	var recurse func(int)
	recurse = func(level int) {
		if level == depth {
			visit(trace)
			return
		}
		for _, op := range ops {
			trace = append(trace, op)
			recurse(level + 1)
			trace = trace[:len(trace)-1]
		}
	}
	recurse(0)
}

func faultOperations(members []MemberID, step, advanceStep time.Duration) []traceOp {
	ops := make([]traceOp, 0, 4*len(members)+1)
	for _, member := range members {
		ops = append(ops, traceOp{kind: opJoin, member: member, dt: step})
	}
	for _, member := range members {
		ops = append(ops, traceOp{kind: opFail, member: member, dt: step})
	}
	for _, member := range members {
		ops = append(ops, traceOp{kind: opReconnect, member: member, dt: step})
	}
	for _, member := range members {
		ops = append(ops, traceOp{kind: opAck, member: member, dt: step})
	}
	return append(ops, traceOp{kind: opAdvance, dt: advanceStep})
}

func runTrace(t *testing.T, trace []traceOp, timeout time.Duration) {
	t.Helper()

	coordinator, err := New(Config{GenerationTimeout: timeout})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	model := newNaiveModel(timeout)
	now := testEpoch

	compareCoordinatorToModel(t, "initial", coordinator, model)
	for i, op := range trace {
		now = now.Add(op.dt)
		generation := uint64(0)
		if op.kind == opAck {
			generation = model.ackTarget()
		}
		gotErr := applyCoordinator(coordinator, op, generation, now)
		wantErr := applyModel(model, op, generation, now)
		label := fmt.Sprintf("step %d %s", i, op)
		compareErrors(t, label, gotErr, wantErr)
		compareCoordinatorToModel(t, label, coordinator, model)
	}
}

func TestExhaustiveFaultSequences(t *testing.T) {
	timeout := 3 * time.Second
	tests := []struct {
		name        string
		members     []MemberID
		depth       int
		step        time.Duration
		advanceStep time.Duration
	}{
		{
			name:        "two-members-distinct-times",
			members:     []MemberID{"a", "b"},
			depth:       5,
			step:        time.Second,
			advanceStep: 4 * time.Second,
		},
		{
			name:        "two-members-same-time",
			members:     []MemberID{"a", "b"},
			depth:       5,
			step:        0,
			advanceStep: timeout,
		},
		{
			name:        "three-members-distinct-times",
			members:     []MemberID{"a", "b", "c"},
			depth:       4,
			step:        time.Second,
			advanceStep: 4 * time.Second,
		},
		{
			name:        "three-members-same-time",
			members:     []MemberID{"a", "b", "c"},
			depth:       4,
			step:        0,
			advanceStep: timeout,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ops := faultOperations(test.members, test.step, test.advanceStep)
			enumerateTraces(ops, test.depth, func(trace []traceOp) {
				if t.Failed() {
					return
				}
				runTrace(t, trace, timeout)
			})
		})
	}
}

func TestRankTableMatchesNaiveForEveryJoinAndFailureOrder(t *testing.T) {
	universe := []MemberID{"a", "b", "c", "d"}
	timeout := time.Hour
	now := testEpoch

	for mask := 1; mask < 1<<len(universe); mask++ {
		var subset []MemberID
		for i, member := range universe {
			if mask&(1<<i) != 0 {
				subset = append(subset, member)
			}
		}
		alive := make(map[MemberID]struct{}, len(subset))
		for _, member := range subset {
			alive[member] = struct{}{}
		}
		wantTable := naiveTable(alive)

		for _, joinOrder := range permutations(subset) {
			coordinator := newTestCoordinator(t, timeout)
			step := 0
			for _, member := range joinOrder {
				mustJoin(t, coordinator, member, now.Add(time.Duration(step)*time.Second))
				step++
			}
			generation := currentGeneration(t, coordinator)
			compareMembers(t, generation.Members, wantTable)

			// Commit before enumerating failures so rank reassignment is
			// exercised from a stable generation as well as from pending ones.
			for _, member := range subset {
				mustAck(t, coordinator, member, generation.Number, now.Add(time.Duration(step)*time.Second))
				step++
			}
			if committed := currentGeneration(t, coordinator); committed.State != GenerationCommitted {
				t.Fatalf("generation %d state %s, want committed", committed.Number, committed.State)
			}

			for _, failOrder := range permutations(subset) {
				copyCoordinator := newTestCoordinator(t, timeout)
				copyStep := 0
				for _, member := range joinOrder {
					mustJoin(t, copyCoordinator, member, now.Add(time.Duration(copyStep)*time.Second))
					copyStep++
				}
				activeGeneration := currentGeneration(t, copyCoordinator)
				for _, member := range subset {
					mustAck(t, copyCoordinator, member, activeGeneration.Number,
						now.Add(time.Duration(copyStep)*time.Second))
					copyStep++
				}

				remaining := make(map[MemberID]struct{}, len(subset))
				for _, member := range subset {
					remaining[member] = struct{}{}
				}
				for _, member := range failOrder {
					mustFail(t, copyCoordinator, member, now.Add(time.Duration(copyStep)*time.Second))
					copyStep++
					delete(remaining, member)

					if len(remaining) == 0 {
						if _, ok := copyCoordinator.Current(); ok {
							t.Fatal("current generation exists after all members failed")
						}
						if got := copyCoordinator.Members(); len(got) != 0 {
							t.Fatalf("members %v, want none", got)
						}
						continue
					}
					generation := currentGeneration(t, copyCoordinator)
					compareMembers(t, generation.Members, naiveTable(remaining))
					if len(generation.Confirmations) != 0 {
						t.Fatalf("new generation after failure inherited confirmations: %+v",
							generation.Confirmations)
					}
				}
			}
		}
	}
}

func compareMembers(t *testing.T, got, want []Member) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("members %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("members %v, want %v", got, want)
		}
	}
}

func permutations(values []MemberID) [][]MemberID {
	work := append([]MemberID(nil), values...)
	var out [][]MemberID
	var recurse func(int)
	recurse = func(index int) {
		if index == len(work) {
			out = append(out, append([]MemberID(nil), work...))
			return
		}
		for i := index; i < len(work); i++ {
			work[index], work[i] = work[i], work[index]
			recurse(index + 1)
			work[index], work[i] = work[i], work[index]
		}
	}
	recurse(0)
	return out
}

func TestReconnectDeadlineInterleavings(t *testing.T) {
	timeout := 10 * time.Second
	type op func(coordinator *Coordinator, model *naiveModel, now time.Time) error
	ops := []struct {
		name string
		run  op
	}{
		{
			name: "late-ack-old-generation",
			run: func(coordinator *Coordinator, model *naiveModel, now time.Time) error {
				const oldGeneration = 2
				got := coordinator.Ack("b", oldGeneration, now)
				want := model.ack("b", oldGeneration, now)
				compareErrors(t, "late old ack", got, want)
				return got
			},
		},
		{
			name: "reconnect",
			run: func(coordinator *Coordinator, model *naiveModel, now time.Time) error {
				got := coordinator.Reconnect("b", now)
				want := model.reconnect("b", now)
				compareErrors(t, "reconnect", got, want)
				return got
			},
		},
		{
			name: "deadline-advance",
			run: func(coordinator *Coordinator, model *naiveModel, now time.Time) error {
				coordinator.Advance(now)
				model.advance(now)
				return nil
			},
		},
	}

	for _, order := range [][3]int{
		{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0},
	} {
		name := fmt.Sprintf("%s-then-%s-then-%s",
			ops[order[0]].name, ops[order[1]].name, ops[order[2]].name)
		t.Run(name, func(t *testing.T) {
			coordinator := newTestCoordinator(t, timeout)
			model := newNaiveModel(timeout)

			mustJoin(t, coordinator, "a", at(0))
			mustJoin(t, coordinator, "b", at(0))
			mustAck(t, coordinator, "a", 2, at(1))

			if err := model.join("a", at(0)); err != nil {
				t.Fatalf("model join a: %v", err)
			}
			if err := model.join("b", at(0)); err != nil {
				t.Fatalf("model join b: %v", err)
			}
			if err := model.ack("a", 2, at(1)); err != nil {
				t.Fatalf("model ack a: %v", err)
			}
			compareCoordinatorToModel(t, "setup", coordinator, model)

			for _, index := range order {
				_ = ops[index].run(coordinator, model, at(10))
				compareCoordinatorToModel(t, ops[index].name, coordinator, model)
			}

			// b never confirmed generation 2 before its deadline. No
			// generation created at or after the deadline may contain that
			// confirmation, and b's reconnection must start from an empty
			// confirmation set.
			history := coordinator.History()
			if len(history) < 3 {
				t.Fatalf("%d generations, want at least 3", len(history))
			}
			for _, generation := range history[2:] {
				for _, confirmation := range generation.Confirmations {
					if confirmation.Member == "b" {
						t.Fatalf("generation %d contains b's pre-deadline confirmation %+v",
							generation.Number, confirmation)
					}
				}
			}
		})
	}
}
