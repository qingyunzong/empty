package boolcov

import (
	"context"
	"errors"
	"testing"
)

// readSpy records every variable read so tests can prove the executor
// never touches operands that short-circuit evaluation skips.
type readSpy struct {
	vals  map[string]bool
	calls map[string]int
}

func newReadSpy(vals map[string]bool) *readSpy {
	return &readSpy{vals: vals, calls: map[string]int{}}
}

func (s *readSpy) read(name string) (bool, error) {
	s.calls[name]++
	v, ok := s.vals[name]
	if !ok {
		return false, errors.New("unknown var: " + name)
	}
	return v, nil
}

func TestShortCircuitAndSkipsRight(t *testing.T) {
	root := &Node{ID: "root", Kind: KindAnd,
		Left:  &Node{ID: "l", Kind: KindVar, Name: "x"},
		Right: &Node{ID: "r", Kind: KindVar, Name: "y"},
	}
	tab := Freeze(root)
	ex := NewExecutor(tab)
	spy := newReadSpy(map[string]bool{"x": false, "y": true})

	v, err := ex.Eval(context.Background(), root, spy.read)
	if err != nil || v {
		t.Fatalf("got (%v, %v), want (false, nil)", v, err)
	}
	if spy.calls["y"] != 0 {
		t.Fatalf("right operand read %d times, want 0 (no read for recording)", spy.calls["y"])
	}
	if got := tab.Count("r"); got != 0 {
		t.Fatalf("right operand counted %d times, want 0", got)
	}
	if tab.Count("root") != 1 || tab.Count("l") != 1 {
		t.Fatalf("started nodes: root=%d l=%d, want 1 each", tab.Count("root"), tab.Count("l"))
	}
}

func TestShortCircuitOrSkipsRight(t *testing.T) {
	root := &Node{ID: "root", Kind: KindOr,
		Left:  &Node{ID: "l", Kind: KindVar, Name: "x"},
		Right: &Node{ID: "r", Kind: KindVar, Name: "y"},
	}
	tab := Freeze(root)
	ex := NewExecutor(tab)
	spy := newReadSpy(map[string]bool{"x": true, "y": false})

	v, err := ex.Eval(context.Background(), root, spy.read)
	if err != nil || !v {
		t.Fatalf("got (%v, %v), want (true, nil)", v, err)
	}
	if spy.calls["y"] != 0 || tab.Count("r") != 0 {
		t.Fatalf("right operand touched: reads=%d count=%d, want 0/0", spy.calls["y"], tab.Count("r"))
	}
}

func TestNestedShortCircuit(t *testing.T) {
	// (false && unreachable1) || (true || unreachable2)
	root := &Node{ID: "root", Kind: KindOr,
		Left: &Node{ID: "and", Kind: KindAnd,
			Left:  &Node{ID: "f", Kind: KindConst, Value: false},
			Right: &Node{ID: "u1", Kind: KindVar, Name: "unreachable1"},
		},
		Right: &Node{ID: "or", Kind: KindOr,
			Left:  &Node{ID: "t", Kind: KindConst, Value: true},
			Right: &Node{ID: "u2", Kind: KindVar, Name: "unreachable2"},
		},
	}
	tab := Freeze(root)
	ex := NewExecutor(tab)
	spy := newReadSpy(map[string]bool{})

	v, err := ex.Eval(context.Background(), root, spy.read)
	if err != nil || !v {
		t.Fatalf("got (%v, %v), want (true, nil)", v, err)
	}
	if len(spy.calls) != 0 {
		t.Fatalf("unreachable vars read: %v", spy.calls)
	}
	want := map[string]uint64{"root": 1, "and": 1, "f": 1, "u1": 0, "or": 1, "t": 1, "u2": 0}
	for id, w := range want {
		if got := tab.Count(id); got != w {
			t.Fatalf("count[%s]=%d, want %d", id, got, w)
		}
	}
}

func TestPanicCountsStartedNodes(t *testing.T) {
	// a && (boom && never): panic at "boom" must leave root, a, inner, boom
	// counted, but never the unreached sibling.
	root := &Node{ID: "root", Kind: KindAnd,
		Left: &Node{ID: "a", Kind: KindVar, Name: "a"},
		Right: &Node{ID: "inner", Kind: KindAnd,
			Left:  &Node{ID: "boom", Kind: KindVar, Name: "boom"},
			Right: &Node{ID: "never", Kind: KindVar, Name: "never"},
		},
	}
	tab := Freeze(root)
	ex := NewExecutor(tab)
	read := func(name string) (bool, error) {
		if name == "boom" {
			panic("read exploded")
		}
		return true, nil
	}

	var panicked any
	func() {
		defer func() { panicked = recover() }()
		_, _ = ex.Eval(context.Background(), root, read)
	}()
	if panicked == nil {
		t.Fatal("expected panic to propagate")
	}
	want := map[string]uint64{"root": 1, "a": 1, "inner": 1, "boom": 1, "never": 0}
	for id, w := range want {
		if got := tab.Count(id); got != w {
			t.Fatalf("count[%s]=%d, want %d", id, got, w)
		}
	}
}

func TestErrorCountsStartedNodes(t *testing.T) {
	boom := errors.New("read failed")
	root := &Node{ID: "root", Kind: KindOr,
		Left:  &Node{ID: "l", Kind: KindNot, Left: &Node{ID: "lv", Kind: KindVar, Name: "x"}},
		Right: &Node{ID: "r", Kind: KindVar, Name: "y"},
	}
	tab := Freeze(root)
	ex := NewExecutor(tab)
	read := func(name string) (bool, error) { return false, boom }

	_, err := ex.Eval(context.Background(), root, read)
	if !errors.Is(err, boom) {
		t.Fatalf("got err %v, want %v", err, boom)
	}
	want := map[string]uint64{"root": 1, "l": 1, "lv": 1, "r": 0}
	for id, w := range want {
		if got := tab.Count(id); got != w {
			t.Fatalf("count[%s]=%d, want %d", id, got, w)
		}
	}
}

func TestCancelledContextStillCountsStartedNode(t *testing.T) {
	root := &Node{ID: "root", Kind: KindVar, Name: "x"}
	tab := Freeze(root)
	ex := NewExecutor(tab)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := ex.Eval(ctx, root, newReadSpy(map[string]bool{"x": true}).read)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got err %v, want context.Canceled", err)
	}
	if got := tab.Count("root"); got != 1 {
		t.Fatalf("started node under cancellation counted %d, want 1", got)
	}
}

func TestNilTableEvaluatesWithoutRecording(t *testing.T) {
	root := &Node{ID: "root", Kind: KindAnd,
		Left:  &Node{ID: "l", Kind: KindConst, Value: true},
		Right: &Node{ID: "r", Kind: KindConst, Value: false},
	}
	ex := NewExecutor(nil)
	v, err := ex.Eval(context.Background(), root, nil)
	if err != nil || v {
		t.Fatalf("got (%v, %v), want (false, nil)", v, err)
	}
}
