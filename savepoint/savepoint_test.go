package savepoint_test

import (
	"errors"
	"reflect"
	"testing"

	"example.org/dlks/formal/q10036/savepoint"
)

func reflectDeepEqual(a, b interface{}) bool {
	return reflect.DeepEqual(a, b)
}

func sameStrings(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}

var (
	lockX = savepoint.Record{ID: "lock-x", Kind: savepoint.RecordLock}
	resA  = savepoint.Record{ID: "res-a", Kind: savepoint.RecordResource}
	resB  = savepoint.Record{ID: "res-b", Kind: savepoint.RecordResource}
	resC  = savepoint.Record{ID: "res-c", Kind: savepoint.RecordResource}
)

func ownerMap(pairs ...interface{}) map[savepoint.Record]string {
	result := map[savepoint.Record]string{}
	for i := 0; i < len(pairs); i += 2 {
		result[pairs[i].(savepoint.Record)] = pairs[i+1].(string)
	}
	return result
}

// TestGoldenScenario is a hand-computed narrative covering empty-stack
// boundaries, duplicate names, nested rollback with reverse-order undo,
// re-establishment after rollback and cross-layer release. Every expected
// value below is a literal produced independently of the package.
func TestGoldenScenario(t *testing.T) {
	events := []savepoint.Event{
		{Seq: 1, Kind: savepoint.KindRollback, Name: "sp1"},
		{Seq: 2, Kind: savepoint.KindRelease, Name: "sp1"},
		{Seq: 3, Kind: savepoint.KindRegister, Record: resA},
		{Seq: 4, Kind: savepoint.KindEstablish, Name: "sp1"},
		{Seq: 5, Kind: savepoint.KindRegister, Record: lockX},
		{Seq: 6, Kind: savepoint.KindEstablish, Name: "sp2"},
		{Seq: 7, Kind: savepoint.KindRegister, Record: resA},
		{Seq: 8, Kind: savepoint.KindEstablish, Name: "sp3"},
		{Seq: 9, Kind: savepoint.KindRegister, Record: resB},
		{Seq: 10, Kind: savepoint.KindRegister, Record: resC},
		{Seq: 11, Kind: savepoint.KindEstablish, Name: "sp1"},
		{Seq: 12, Kind: savepoint.KindRollback, Name: "ghost"},
		{Seq: 13, Kind: savepoint.KindRollback, Name: "sp2"},
		{Seq: 14, Kind: savepoint.KindEstablish, Name: "sp3"},
		{Seq: 15, Kind: savepoint.KindRegister, Record: resB},
		{Seq: 16, Kind: savepoint.KindRelease, Name: "sp2"},
		{Seq: 17, Kind: savepoint.KindRollback, Name: "sp1"},
		{Seq: 18, Kind: savepoint.KindRelease, Name: "sp1"},
		{Seq: 19, Kind: savepoint.KindRollback, Name: "sp1"},
	}

	type golden struct {
		stack  []string
		owners map[savepoint.Record]string
		undone []savepoint.Record
		err    oracleError
	}

	want := []golden{
		0: {nil, map[savepoint.Record]string{}, nil, errEmpty},
		1: {nil, map[savepoint.Record]string{}, nil, errEmpty},
		2: {nil, map[savepoint.Record]string{}, nil, errNoActive},
		3: {[]string{"sp1"}, map[savepoint.Record]string{}, nil, errNone},
		4: {[]string{"sp1"}, ownerMap(lockX, "sp1"), nil, errNone},
		5: {[]string{"sp1", "sp2"}, ownerMap(lockX, "sp1"), nil, errNone},
		6: {[]string{"sp1", "sp2"}, ownerMap(lockX, "sp1", resA, "sp2"), nil, errNone},
		7: {[]string{"sp1", "sp2", "sp3"}, ownerMap(lockX, "sp1", resA, "sp2"), nil, errNone},
		8: {[]string{"sp1", "sp2", "sp3"}, ownerMap(lockX, "sp1", resA, "sp2", resB, "sp3"), nil, errNone},
		9: {[]string{"sp1", "sp2", "sp3"}, ownerMap(lockX, "sp1", resA, "sp2", resB, "sp3", resC, "sp3"), nil, errNone},
		// Duplicate name and unknown name: errors only, state unchanged.
		10: {[]string{"sp1", "sp2", "sp3"}, ownerMap(lockX, "sp1", resA, "sp2", resB, "sp3", resC, "sp3"), nil, errDuplicate},
		11: {[]string{"sp1", "sp2", "sp3"}, ownerMap(lockX, "sp1", resA, "sp2", resB, "sp3", resC, "sp3"), nil, errNotFound},
		// Rollback to sp2 pops sp3; records return in reverse registration.
		12: {[]string{"sp1", "sp2"}, ownerMap(lockX, "sp1", resA, "sp2"), []savepoint.Record{resC, resB}, errNone},
		// Re-establish the rolled-back name as a fresh inner layer.
		13: {[]string{"sp1", "sp2", "sp3"}, ownerMap(lockX, "sp1", resA, "sp2"), nil, errNone},
		14: {[]string{"sp1", "sp2", "sp3"}, ownerMap(lockX, "sp1", resA, "sp2", resB, "sp3"), nil, errNone},
		// Cross-layer release of sp2: it disappears, resA is re-homed to sp1,
		// inner sp3 and its ownership of resB stay intact.
		15: {[]string{"sp1", "sp3"}, ownerMap(lockX, "sp1", resA, "sp1", resB, "sp3"), nil, errNone},
		// Rollback to sp1 pops sp3 and returns resB; sp1 itself is retained.
		16: {[]string{"sp1"}, ownerMap(lockX, "sp1", resA, "sp1"), []savepoint.Record{resB}, errNone},
		// Releasing the only layer moves its records to engine/root ownership.
		17: {nil, ownerMap(lockX, "", resA, ""), nil, errNone},
		// Stack is empty again.
		18: {nil, ownerMap(lockX, "", resA, ""), nil, errEmpty},
	}

	manager := savepoint.NewManager()
	reference := newOracle()
	for i, event := range events {
		got := manager.Apply(event)
		oracleWants := reference.apply(event)
		assertStep(t, event, got, oracleWants)

		g := want[i]
		if !sameStrings(got.Stack, g.stack) {
			t.Fatalf("seq %d: literal stack mismatch: got %v want %v", event.Seq, got.Stack, g.stack)
		}
		if !reflect.DeepEqual(got.Owners, g.owners) {
			t.Fatalf("seq %d: literal owners mismatch: got %v want %v", event.Seq, got.Owners, g.owners)
		}
		if !sameRecords(got.Undone, g.undone) {
			t.Fatalf("seq %d: literal undone mismatch: got %v want %v", event.Seq, got.Undone, g.undone)
		}
		if errorClass(got.Err) != g.err {
			t.Fatalf("seq %d: literal error mismatch: got %q want %q", event.Seq, errorClass(got.Err), g.err)
		}
	}
}

// TestExhaustiveDifferential enumerates every reachable state of the naive
// oracle via BFS over all legal event shapes and, at each state, replays each
// candidate event against a fresh package manager built from the same event
// prefix. This exhausts rollback-then-re-establish cycles, cross-layer
// releases at every depth, re-registration and all empty-stack boundaries.
func TestExhaustiveDifferential(t *testing.T) {
	const maxDepth = 6

	names := []string{"a", "b", "c"}
	records := []savepoint.Record{
		{ID: "r1", Kind: savepoint.RecordResource},
		{ID: "r2", Kind: savepoint.RecordLock},
	}

	var candidates []savepoint.Event
	seq := 0
	nextSeq := func() int {
		seq++
		return seq
	}
	for _, name := range names {
		candidates = append(candidates, savepoint.Event{Seq: nextSeq(), Kind: savepoint.KindEstablish, Name: name})
		candidates = append(candidates, savepoint.Event{Seq: nextSeq(), Kind: savepoint.KindRollback, Name: name})
		candidates = append(candidates, savepoint.Event{Seq: nextSeq(), Kind: savepoint.KindRelease, Name: name})
	}
	for _, rec := range records {
		candidates = append(candidates, savepoint.Event{Seq: nextSeq(), Kind: savepoint.KindRegister, Record: rec})
	}
	candidates = append(candidates, savepoint.Event{Seq: nextSeq(), Kind: savepoint.Kind(99), Name: "ignored"})

	type node struct {
		state  *oracle
		prefix []savepoint.Event
		depth  int
	}

	visited := map[string]bool{}
	queue := []node{{state: newOracle()}}
	visited[queue[0].state.key()] = true

	statesVisited := 0
	edgesChecked := 0

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		statesVisited++

		for _, candidate := range candidates {
			event := candidate
			event.Seq = current.depth*100 + candidate.Seq

			expected := current.state.deepCopy().apply(event)

			manager := savepoint.NewManager()
			for _, prior := range current.prefix {
				manager.Apply(prior)
			}
			got := manager.Apply(event)
			assertStep(t, event, got, expected)
			edgesChecked++

			if current.depth >= maxDepth || expected.err != errNone {
				continue
			}
			nextOracle := current.state.deepCopy()
			nextOracle.apply(event)
			key := nextOracle.key()
			if visited[key] {
				continue
			}
			visited[key] = true

			prefix := make([]savepoint.Event, 0, len(current.prefix)+1)
			prefix = append(prefix, current.prefix...)
			prefix = append(prefix, event)
			queue = append(queue, node{state: nextOracle, prefix: prefix, depth: current.depth + 1})
		}
	}

	t.Logf("exhaustive differential: %d reachable states, %d edges checked", statesVisited, edgesChecked)
	if statesVisited < 50 {
		t.Fatalf("expected broad state coverage, only visited %d states", statesVisited)
	}
}

// TestInvalidOperationsAreAtomic checks the no-state-change guarantee directly
// through the exported accessors on both empty and populated stacks.
func TestInvalidOperationsAreAtomic(t *testing.T) {
	manager := savepoint.NewManager()

	if _, err := manager.Rollback("x"); !errorsIs(err, savepoint.ErrEmptyStack) {
		t.Fatalf("empty rollback: got %v, want ErrEmptyStack", err)
	}
	if _, err := manager.Release("x"); !errorsIs(err, savepoint.ErrEmptyStack) {
		t.Fatalf("empty release: got %v, want ErrEmptyStack", err)
	}
	if err := manager.Register(resA); !errorsIs(err, savepoint.ErrNoActiveSavepoint) {
		t.Fatalf("empty register: got %v, want ErrNoActiveSavepoint", err)
	}
	if manager.Depth() != 0 || len(manager.Stack()) != 0 || len(manager.Owners()) != 0 {
		t.Fatal("invalid operations on empty stack mutated state")
	}

	if err := manager.Establish("a"); err != nil {
		t.Fatalf("establish a: %v", err)
	}
	if err := manager.Register(resA); err != nil {
		t.Fatalf("register resA: %v", err)
	}
	if err := manager.Establish("b"); err != nil {
		t.Fatalf("establish b: %v", err)
	}
	if err := manager.Register(lockX); err != nil {
		t.Fatalf("register lockX: %v", err)
	}

	snapshotStack := manager.Stack()
	snapshotOwners := manager.Owners()

	if err := manager.Establish("a"); !errorsIs(err, savepoint.ErrDuplicateSavepoint) {
		t.Fatalf("duplicate establish: got %v, want ErrDuplicateSavepoint", err)
	}
	if _, err := manager.Rollback("missing"); !errorsIs(err, savepoint.ErrSavepointNotFound) {
		t.Fatalf("unknown rollback: got %v, want ErrSavepointNotFound", err)
	}
	if _, err := manager.Release("missing"); !errorsIs(err, savepoint.ErrSavepointNotFound) {
		t.Fatalf("unknown release: got %v, want ErrSavepointNotFound", err)
	}
	if !reflect.DeepEqual(manager.Stack(), snapshotStack) {
		t.Fatalf("stack changed after failed operations: %v vs %v", manager.Stack(), snapshotStack)
	}
	if !reflect.DeepEqual(manager.Owners(), snapshotOwners) {
		t.Fatalf("owners changed after failed operations: %v vs %v", manager.Owners(), snapshotOwners)
	}

	// Returned accessor slices and maps must be defensive copies.
	manager.Stack()[0] = "tampered"
	manager.Owners()[resA] = "tampered"
	if manager.Stack()[0] != "a" || manager.Owners()[resA] != "a" {
		t.Fatal("Stack/Owners accessors leaked internal state")
	}
}

func errorsIs(err, target error) bool { return errors.Is(err, target) }
