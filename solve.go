package main

import (
	"strconv"
	"strings"
)

// Step is one entry of a witness linearization.
type Step struct {
	Op       int    // index into the ops slice
	Omitted  bool   // pending op dropped from the serial explanation
	DeqEmpty bool   // effective deq result: returned empty
	DeqVal   string // effective deq result: returned value
}

// Solve is the primary checker: a depth-first search over serial
// explanations, memoized on (placed-ops mask, queue contents).
//
// It returns a witness linearization respecting the real-time order and
// the FIFO semantics of a queue, or ok=false if none exists. Pending
// operations may be omitted or completed with any legal response.
func Solve(ops []Op) (witness []Step, ok bool) {
	n := len(ops)
	preds := Predecessors(ops)
	full := (1 << n) - 1
	failed := make(map[string]bool)
	var path []Step

	var dfs func(mask int, queue []string) bool
	dfs = func(mask int, queue []string) bool {
		if mask == full {
			return true
		}
		key := strconv.Itoa(mask) + "|" + strings.Join(queue, "\x1f")
		if failed[key] {
			return false
		}
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 || preds[i]&^mask != 0 {
				continue
			}
			op := ops[i]
			try := func(st Step, nq []string) bool {
				path = append(path, st)
				if dfs(mask|1<<i, nq) {
					return true
				}
				path = path[:len(path)-1]
				return false
			}
			if op.Kind == Enq {
				if op.Pending {
					if try(Step{Op: i, Omitted: true}, queue) {
						return true
					}
				}
				nq := make([]string, len(queue)+1)
				copy(nq, queue)
				nq[len(queue)] = op.Val
				if try(Step{Op: i}, nq) {
					return true
				}
				continue
			}
			// Deq.
			if op.Pending {
				if try(Step{Op: i, Omitted: true}, queue) {
					return true
				}
				if len(queue) == 0 {
					if try(Step{Op: i, DeqEmpty: true}, queue) {
						return true
					}
				} else if try(Step{Op: i, DeqVal: queue[0]}, queue[1:]) {
					return true
				}
				continue
			}
			if op.RetEmpty {
				if len(queue) == 0 {
					if try(Step{Op: i, DeqEmpty: true}, queue) {
						return true
					}
				}
			} else if len(queue) > 0 && queue[0] == op.Val {
				if try(Step{Op: i, DeqVal: op.Val}, queue[1:]) {
					return true
				}
			}
		}
		failed[key] = true
		return false
	}

	if dfs(0, nil) {
		return path, true
	}
	return nil, false
}
