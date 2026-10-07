package txnlib

import "sort"

// VerifySerializable independently checks whether the given history is
// serializable, without using the commit-time cycle detector: it derives
// precedence constraints directly from the recorded operations and then
// enumerates serial orders with a subset DP (2^n states, feasible because
// histories are capped at MaxTransactions). When a serial order exists it
// returns one as a witness.
func VerifySerializable(txns []*Txn) (bool, []TxnID) {
	n := len(txns)
	if n == 0 {
		return true, nil
	}
	if n > MaxTransactions {
		return false, nil
	}

	// Precedence constraints, derived independently from the operations:
	//   wr: reader must follow the writer of the value it observed;
	//   rw: reader must precede any later writer of a covered key;
	//   ww: writers of one key keep their operation order.
	prec := make([]int, n) // bitmask of transactions that must come first
	type wref struct {
		txn int
		seq int
	}
	writesByKey := make(map[string][]wref)
	for i, t := range txns {
		for _, w := range t.Writes {
			writesByKey[w.Key] = append(writesByKey[w.Key], wref{i, w.Seq})
		}
	}
	for _, ws := range writesByKey {
		sort.Slice(ws, func(a, b int) bool { return ws[a].seq < ws[b].seq })
	}
	for j, t := range txns {
		for _, r := range t.Reads {
			for key := range r.Values {
				ws := writesByKey[key]
				latest := -1
				for i := range ws {
					if ws[i].seq < r.Seq {
						latest = i
					}
				}
				if latest >= 0 && ws[latest].txn != j {
					prec[j] |= 1 << uint(ws[latest].txn)
				}
			}
			for key, ws := range writesByKey {
				if !r.Pred.Covers(key) {
					continue
				}
				for _, w := range ws {
					if w.txn != j && w.seq > r.Seq {
						prec[w.txn] |= 1 << uint(j)
					}
				}
			}
		}
	}
	for _, ws := range writesByKey {
		for i := 0; i+1 < len(ws); i++ {
			prec[ws[i+1].txn] |= 1 << uint(ws[i].txn)
		}
	}

	// Subset DP over serial orders: reach[mask] records which transaction
	// was placed last to reach mask. A transaction may be appended once
	// all its predecessors are placed.
	full := 1<<uint(n) - 1
	placed := make(map[int]int, 1<<uint(n))
	placed[0] = -1
	for mask := 0; mask <= full; mask++ {
		if _, ok := placed[mask]; !ok {
			continue
		}
		for t := 0; t < n; t++ {
			bit := 1 << uint(t)
			if mask&bit != 0 || prec[t]&^mask != 0 {
				continue
			}
			next := mask | bit
			if _, ok := placed[next]; !ok {
				placed[next] = t
			}
		}
	}
	if _, ok := placed[full]; !ok {
		return false, nil
	}
	order := make([]TxnID, 0, n)
	for mask := full; mask != 0; {
		t := placed[mask]
		order = append(order, txns[t].ID)
		mask &^= 1 << uint(t)
	}
	for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
		order[i], order[j] = order[j], order[i]
	}
	return true, order
}
