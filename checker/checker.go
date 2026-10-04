// Package checker decides whether an observed queue history (up to 12
// operations with invocation/response times) admits a serial explanation
// consistent with the real-time order, i.e. whether it is linearizable
// with respect to a FIFO queue. Operations without a recorded response
// ("pending") may be completed arbitrarily or omitted entirely.
package checker

import (
	"fmt"
	"strconv"
	"strings"
)

type Kind int

const (
	Enqueue Kind = iota
	Dequeue
)

// Op is a single observed queue operation.
type Op struct {
	ID      int   // 1-based identifier from the input
	Kind    Kind  // Enqueue or Dequeue
	Val     int   // enqueued value, or value returned by a completed dequeue
	Empty   bool  // completed dequeue returned "empty"
	Call    int64 // invocation time
	Ret     int64 // response time (meaningless when Pending)
	Pending bool  // no response observed; may be omitted or completed
}

func (o Op) String() string {
	if o.Kind == Enqueue {
		if o.Pending {
			return fmt.Sprintf("#%d enq(%d) call=%d ret=pending", o.ID, o.Val, o.Call)
		}
		return fmt.Sprintf("#%d enq(%d) call=%d ret=%d", o.ID, o.Val, o.Call, o.Ret)
	}
	res := strconv.Itoa(o.Val)
	if o.Empty {
		res = "empty"
	}
	if o.Pending {
		return fmt.Sprintf("#%d deq(?) call=%d ret=pending", o.ID, o.Call)
	}
	return fmt.Sprintf("#%d deq(%s) call=%d ret=%d", o.ID, res, o.Call, o.Ret)
}

// Step applies one operation to the queue state in a serial execution.
// A pending dequeue is completed as returning the head (or empty).
func Step(queue []int, o Op) ([]int, bool) {
	if o.Kind == Enqueue {
		nq := make([]int, len(queue)+1)
		copy(nq, queue)
		nq[len(queue)] = o.Val
		return nq, true
	}
	if o.Pending {
		if len(queue) == 0 {
			return queue, true
		}
		return queue[1:], true
	}
	if len(queue) == 0 {
		return queue, o.Empty
	}
	if o.Empty || queue[0] != o.Val {
		return queue, false
	}
	return queue[1:], true
}

// Validate checks that seq is a legal serial queue execution that respects
// the real-time order: a completed operation whose response precedes another
// operation's invocation must appear earlier in the sequence.
func Validate(seq []Op) error {
	queue := []int{}
	for pos, o := range seq {
		for _, later := range seq[pos+1:] {
			if !later.Pending && later.Ret < o.Call {
				return fmt.Errorf("real-time violation: %s must precede %s", later, o)
			}
		}
		nq, ok := Step(queue, o)
		if !ok {
			return fmt.Errorf("queue semantics violated at position %d: %s", pos+1, o)
		}
		queue = nq
	}
	return nil
}

// ---------------------------------------------------------------------------
// Primary solver: memoized depth-first search over the real-time poset.
// ---------------------------------------------------------------------------

type stateKey struct {
	rem   uint16
	queue string
}

func encodeQueue(queue []int) string {
	var b strings.Builder
	for _, v := range queue {
		fmt.Fprintf(&b, "%d,", v)
	}
	return b.String()
}

type solver struct {
	ops  []Op
	pred []uint16 // pred[i]: operations that real-time forces before i
	dead map[stateKey]bool
}

// Solve finds a serial explanation, or proves none exists. The returned
// slice is the witness order (omitted pending operations are excluded).
func Solve(ops []Op) ([]Op, bool) {
	s := &solver{
		ops:  ops,
		pred: make([]uint16, len(ops)),
		dead: map[stateKey]bool{},
	}
	for i := range ops {
		for j := range ops {
			if i != j && !ops[j].Pending && ops[j].Ret < ops[i].Call {
				s.pred[i] |= 1 << uint(j)
			}
		}
	}
	full := uint16(1<<uint(len(ops))) - 1
	return s.dfs(full, nil)
}

func (s *solver) dfs(rem uint16, queue []int) ([]Op, bool) {
	allPending := true
	for i := range s.ops {
		if rem&(1<<uint(i)) != 0 && !s.ops[i].Pending {
			allPending = false
			break
		}
	}
	if allPending {
		return nil, true // remaining pending ops are omitted
	}
	key := stateKey{rem: rem, queue: encodeQueue(queue)}
	if s.dead[key] {
		return nil, false
	}
	for i := range s.ops {
		bit := uint16(1) << uint(i)
		if rem&bit == 0 {
			continue
		}
		o := s.ops[i]
		if o.Pending {
			// Option 1: omit this pending operation.
			if seq, ok := s.dfs(rem&^bit, queue); ok {
				return seq, true
			}
		}
		if s.pred[i]&rem != 0 {
			continue // a real-time predecessor is still unresolved
		}
		nq, ok := Step(queue, o)
		if !ok {
			continue
		}
		// Option 2: place this operation next in the serial order.
		if seq, ok := s.dfs(rem&^bit, nq); ok {
			return append([]Op{o}, seq...), true
		}
	}
	s.dead[key] = true
	return nil, false
}

// ---------------------------------------------------------------------------
// Independent verifier: brute-force enumeration of subsets x permutations.
// ---------------------------------------------------------------------------

// BruteForce independently cross-checks Solve by enumerating every subset of
// the pending operations (each may be omitted) and, for each subset, every
// permutation, testing real-time order and queue semantics incrementally.
func BruteForce(ops []Op) ([]Op, bool) {
	var pending []int
	inSubset := make([]bool, len(ops))
	for i := range ops {
		if ops[i].Pending {
			pending = append(pending, i)
		} else {
			inSubset[i] = true
		}
	}
	for mask := 0; mask < 1<<uint(len(pending)); mask++ {
		for k, idx := range pending {
			inSubset[idx] = mask&(1<<uint(k)) != 0
		}
		used := make([]bool, len(ops))
		if seq, ok := enumerate(ops, inSubset, used, nil, nil); ok {
			return seq, true
		}
	}
	return nil, false
}

func enumerate(ops []Op, inSubset, used []bool, queue []int, cur []Op) ([]Op, bool) {
	full := true
	for i := range ops {
		if inSubset[i] && !used[i] {
			full = false
			break
		}
	}
	if full {
		return cur, true
	}
	for i := range ops {
		if !inSubset[i] || used[i] {
			continue
		}
		o := ops[i]
		// Real-time prefix check: every completed operation whose response
		// precedes o's invocation must already be placed.
		ok := true
		for j := range ops {
			if j != i && inSubset[j] && !used[j] && !ops[j].Pending && ops[j].Ret < o.Call {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		nq, ok := Step(queue, o)
		if !ok {
			continue
		}
		used[i] = true
		if seq, ok := enumerate(ops, inSubset, used, nq, append(cur, o)); ok {
			return seq, true
		}
		used[i] = false
	}
	return nil, false
}
