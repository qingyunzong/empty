package main

// BruteResult summarizes the independent exhaustive enumeration.
type BruteResult struct {
	Linearizable bool
	Subsets      int   // omission subsets of pending ops considered
	Permutations int64 // complete permutations simulated to the end
}

// BruteForce is the independent cross-check for Solve. It enumerates
// every subset of pending operations to omit and, for each subset, every
// permutation of the remaining operations that respects the real-time
// order, simulating the queue semantics directly. It shares only the Op
// data model with Solve; the search and simulation are separate.
func BruteForce(ops []Op) BruteResult {
	n := len(ops)
	preds := Predecessors(ops)

	var pending []int
	for i, op := range ops {
		if op.Pending {
			pending = append(pending, i)
		}
	}

	var res BruteResult
	// Enumerate all 2^|pending| omission subsets. Bit k set => pending[k] omitted.
	for sub := 0; sub < 1<<uint(len(pending)); sub++ {
		omitted := 0
		for k, p := range pending {
			if sub&(1<<uint(k)) != 0 {
				omitted |= 1 << uint(p)
			}
		}
		res.Subsets++
		var active []int
		activeMask := 0
		for i := 0; i < n; i++ {
			if omitted&(1<<uint(i)) == 0 {
				active = append(active, i)
				activeMask |= 1 << uint(i)
			}
		}
		// Enumerate permutations of `active`, pruning prefixes that violate
		// the real-time order or the queue semantics.
		queue := make([]string, 0, n)
		used := 0
		var permute func() bool
		permute = func() bool {
			if used == activeMask {
				res.Permutations++
				return true
			}
			for _, i := range active {
				bit := 1 << uint(i)
				if used&bit != 0 {
					continue
				}
				// Real-time check: every predecessor still in the active
				// set must already be placed.
				if preds[i]&activeMask&^used != 0 {
					continue
				}
				op := ops[i]
				if op.Kind == Enq {
					queue = append(queue, op.Val)
					used |= bit
					if permute() {
						return true
					}
					used &^= bit
					queue = queue[:len(queue)-1]
					continue
				}
				// Deq. A pending deq accepts any legal completion, so it
				// never blocks: empty queue -> empty return, else pop front.
				switch {
				case op.Pending:
					if len(queue) == 0 {
						used |= bit
						if permute() {
							return true
						}
						used &^= bit
					} else {
						front := queue[0]
						queue = queue[1:]
						used |= bit
						if permute() {
							return true
						}
						used &^= bit
						queue = append([]string{front}, queue...)
					}
				case op.RetEmpty:
					if len(queue) == 0 {
						used |= bit
						if permute() {
							return true
						}
						used &^= bit
					}
				default:
					if len(queue) > 0 && queue[0] == op.Val {
						front := queue[0]
						queue = queue[1:]
						used |= bit
						if permute() {
							return true
						}
						used &^= bit
						queue = append([]string{front}, queue...)
					}
				}
			}
			return false
		}
		if permute() {
			res.Linearizable = true
			return res
		}
	}
	return res
}
