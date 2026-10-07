package boolcov

import (
	"context"
	"fmt"
	"hash/fnv"
	"math/rand"
	"testing"
)

// genAST builds a random AST with unique node IDs and variables drawn
// from a small pool so reads repeat across evaluations.
func genAST(r *rand.Rand, depth int, nextID *int, vars []string) *Node {
	id := fmt.Sprintf("n%d", *nextID)
	*nextID++
	if depth == 0 || r.Intn(3) == 0 {
		if r.Intn(2) == 0 {
			return &Node{ID: id, Kind: KindConst, Value: r.Intn(2) == 0}
		}
		return &Node{ID: id, Kind: KindVar, Name: vars[r.Intn(len(vars))]}
	}
	switch r.Intn(3) {
	case 0:
		return &Node{ID: id, Kind: KindNot, Left: genAST(r, depth-1, nextID, vars)}
	case 1:
		return &Node{ID: id, Kind: KindAnd, Left: genAST(r, depth-1, nextID, vars), Right: genAST(r, depth-1, nextID, vars)}
	default:
		return &Node{ID: id, Kind: KindOr, Left: genAST(r, depth-1, nextID, vars), Right: genAST(r, depth-1, nextID, vars)}
	}
}

// refEval is the independent reference evaluator. It counts every node it
// starts in visits and uses the same short-circuit rules; the instrumented
// executor must match it exactly.
func refEval(n *Node, read Reader, visits map[string]uint64) (bool, error) {
	visits[n.ID]++
	switch n.Kind {
	case KindConst:
		return n.Value, nil
	case KindVar:
		return read(n.Name)
	case KindNot:
		v, err := refEval(n.Left, read, visits)
		if err != nil {
			return false, err
		}
		return !v, nil
	case KindAnd:
		l, err := refEval(n.Left, read, visits)
		if err != nil || !l {
			return l, err
		}
		return refEval(n.Right, read, visits)
	case KindOr:
		l, err := refEval(n.Left, read, visits)
		if err != nil || l {
			return l, err
		}
		return refEval(n.Right, read, visits)
	default:
		panic("bad kind")
	}
}

// countingRead resolves variables deterministically from the seed and
// records every call, so read side effects can be compared between the
// instrumented executor and the reference.
type countingRead struct {
	seed  int64
	calls map[string]int
}

func (c *countingRead) read(name string) (bool, error) {
	c.calls[name]++
	h := fnv.New64a()
	h.Write([]byte(name))
	h.Write([]byte{byte(c.seed), byte(c.seed >> 8)})
	return h.Sum64()%2 == 0, nil
}

func TestRandomASTsMatchReference(t *testing.T) {
	vars := []string{"p", "q", "r", "s"}
	for seed := int64(0); seed < 200; seed++ {
		r := rand.New(rand.NewSource(seed))
		nextID := 0
		root := genAST(r, 5, &nextID, vars)

		tab := Freeze(root)
		ex := NewExecutor(tab)
		inRead := &countingRead{seed: seed, calls: map[string]int{}}
		gotVal, gotErr := ex.Eval(context.Background(), root, inRead.read)

		visits := map[string]uint64{}
		refRead := &countingRead{seed: seed, calls: map[string]int{}}
		wantVal, wantErr := refEval(root, refRead.read, visits)

		if gotVal != wantVal || (gotErr == nil) != (wantErr == nil) {
			t.Fatalf("seed %d: executor (%v,%v) != reference (%v,%v)", seed, gotVal, gotErr, wantVal, wantErr)
		}
		// Read side effects must be identical: no extra reads for recording.
		if fmt.Sprint(inRead.calls) != fmt.Sprint(refRead.calls) {
			t.Fatalf("seed %d: read side effects differ: executor %v, reference %v", seed, inRead.calls, refRead.calls)
		}
		// Every frozen node's count must equal the reference visit count.
		for id := range tab.Snapshot() {
			if got, want := tab.Count(id), visits[id]; got != want {
				t.Fatalf("seed %d: count[%s]=%d, reference=%d", seed, id, got, want)
			}
		}
	}
}

func TestRandomASTsWithPanicsMatchReference(t *testing.T) {
	vars := []string{"p", "q", "boom", "s"}
	wrap := func(read Reader) Reader {
		return func(name string) (bool, error) {
			if name == "boom" {
				panic("boom read")
			}
			return read(name)
		}
	}
	evalSafe := func(ex *Executor, root *Node, read Reader) (panicked any) {
		defer func() { panicked = recover() }()
		_, _ = ex.Eval(context.Background(), root, read)
		return nil
	}
	refSafe := func(root *Node, read Reader, visits map[string]uint64) (panicked any) {
		defer func() { panicked = recover() }()
		_, _ = refEval(root, read, visits)
		return nil
	}

	for seed := int64(0); seed < 200; seed++ {
		r := rand.New(rand.NewSource(seed))
		nextID := 0
		root := genAST(r, 5, &nextID, vars)

		tab := Freeze(root)
		ex := NewExecutor(tab)
		inRead := &countingRead{seed: seed, calls: map[string]int{}}
		inPanic := evalSafe(ex, root, wrap(inRead.read))

		visits := map[string]uint64{}
		refRead := &countingRead{seed: seed, calls: map[string]int{}}
		refPanic := refSafe(root, wrap(refRead.read), visits)

		if (inPanic == nil) != (refPanic == nil) {
			t.Fatalf("seed %d: panic mismatch: executor %v, reference %v", seed, inPanic, refPanic)
		}
		if fmt.Sprint(inRead.calls) != fmt.Sprint(refRead.calls) {
			t.Fatalf("seed %d: read side effects differ under panic: executor %v, reference %v", seed, inRead.calls, refRead.calls)
		}
		// Even with a panic unwinding the stack, every started node is counted.
		for id := range tab.Snapshot() {
			if got, want := tab.Count(id), visits[id]; got != want {
				t.Fatalf("seed %d: count[%s]=%d, reference=%d (panic path)", seed, id, got, want)
			}
		}
	}
}
