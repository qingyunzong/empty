package dataeng

import (
	"errors"
	"sort"
	"testing"
)

func wantFailure(t *testing.T, req Request, code FailureCode) {
	t.Helper()
	plan, err := PlanSplit(req)
	if plan != nil {
		t.Fatalf("expected no partial plan, got %#v", plan)
	}
	var failure *Failure
	if !errors.As(err, &failure) {
		t.Fatalf("expected *Failure, got %T: %v", err, err)
	}
	if failure.Code != code {
		t.Fatalf("expected failure code %q, got %q (%v)", code, failure.Code, err)
	}
}

type pairShape struct{ r, s int }

type oracleResult struct {
	ok       bool
	code     FailureCode
	seq      []pairShape
	cells    int
	transfer int64
}

func oracleEnumerate(left, right, slots int, maxPairs int64) []pairShape {
	var out []pairShape
	for r := 1; r <= left && r <= slots; r++ {
		for s := 1; s <= right && s <= slots; s++ {
			if r > slots/s {
				continue
			}
			worstLeft := ceilDiv(int64(left), int64(r))
			worstRight := ceilDiv(int64(right), int64(s))
			if productOverflows(worstLeft, worstRight) ||
				worstLeft*worstRight > maxPairs {
				continue
			}
			out = append(out, pairShape{r, s})
		}
	}
	return out
}

func oraclePlan(left, right map[string]int64, slots int, maxPairs int64) oracleResult {
	union := map[string]struct{}{}
	for k := range left {
		union[k] = struct{}{}
	}
	for k := range right {
		union[k] = struct{}{}
	}
	var keys []string
	for k := range union {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	type keyOpts struct {
		key string
		opt []pairShape
	}
	var active []keyOpts
	for _, k := range keys {
		l, r := left[k], right[k]
		if l == 0 || r == 0 {
			continue
		}
		opts := oracleEnumerate(int(l), int(r), slots, maxPairs)
		if len(opts) == 0 {
			return oracleResult{ok: false, code: KeyInfeasible}
		}
		active = append(active, keyOpts{k, opts})
	}
	if len(active) == 0 {
		return oracleResult{ok: true}
	}

	best := oracleResult{ok: false, code: BudgetExceeded}
	haveBest := false

	var dfs func(idx, cells int, transfer int64, seq []pairShape)
	dfs = func(idx, cells int, transfer int64, seq []pairShape) {
		if idx == len(active) {
			cand := oracleResult{
				ok:       true,
				seq:      append([]pairShape(nil), seq...),
				cells:    cells,
				transfer: transfer,
			}
			if !haveBest || oracleBetter(cand, best) {
				best, haveBest = cand, true
			}
			return
		}
		l, r := left[active[idx].key], right[active[idx].key]
		for _, opt := range active[idx].opt {
			newCells := cells + opt.r*opt.s
			if newCells > slots {
				continue
			}
			newTransfer := transfer + l*int64(opt.s) + r*int64(opt.r)
			dfs(idx+1, newCells, newTransfer, append(seq, opt))
		}
	}
	dfs(0, 0, 0, nil)

	if !haveBest {
		return oracleResult{ok: false, code: BudgetExceeded}
	}
	return best
}

func oracleBetter(a, b oracleResult) bool {
	if a.transfer != b.transfer {
		return a.transfer < b.transfer
	}
	if a.cells != b.cells {
		return a.cells < b.cells
	}
	for i := range a.seq {
		if a.seq[i] != b.seq[i] {
			if a.seq[i].r != b.seq[i].r {
				return a.seq[i].r < b.seq[i].r
			}
			return a.seq[i].s < b.seq[i].s
		}
	}
	return false
}
