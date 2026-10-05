package contractopt

// Enumerate exhaustively explores every subset of contracts and every
// candidate start assignment, returning the optimal solution to cross-check Solve.
// It is exponential and intended for small instances (tests, audits).
func Enumerate(in *Instance) (Solution, int, error) {
	if err := in.Validate(); err != nil {
		return Solution{}, 0, err
	}
	e := &enumerator{in: in, idx: in.index(), n: len(in.Contracts)}
	e.sel = make([]int, e.n)
	for i := range e.sel {
		e.sel[i] = -1
	}
	e.dec = make([]bool, e.n)
	e.used = make([][]int64, in.Periods)
	for p := range e.used {
		e.used[p] = make([]int64, in.Resources)
	}
	e.group = make(map[string]bool)
	e.dfs(0)
	if !e.hasBest {
		return Solution{}, e.feasible, ErrInfeasible
	}
	return Solution{Assign: e.best, Revenue: e.bestRev, Usage: e.bestUsage}, e.feasible, nil
}

// VerifyOptimalByEnumeration cross-checks a solution against brute-force
// subset enumeration: the solution must be feasible and match the enumerated
// optimum on both objective components.
func VerifyOptimalByEnumeration(in *Instance, sol Solution) error {
	if _, err := in.Evaluate(sol.Assign); err != nil {
		return err
	}
	best, _, err := Enumerate(in)
	if err != nil {
		return err
	}
	if sol.Revenue != best.Revenue || sol.Usage != best.Usage {
		return errMismatch("enumeration", sol, best)
	}
	return nil
}

func errMismatch(how string, got, want Solution) error {
	return enumError{how: how, got: got, want: want}
}

type enumError struct {
	how  string
	got  Solution
	want Solution
}

func (e enumError) Error() string {
	return "contractopt: " + e.how + " mismatch"
}

// enumerator mirrors the solver's recursion without any pruning.
type enumerator struct {
	in    *Instance
	idx   map[string]int
	n     int
	used  [][]int64
	sel   []int
	dec   []bool
	group map[string]bool
	count int
	rev   int64
	usage int64

	feasible  int
	best      map[string]int
	bestRev   int64
	bestUsage int64
	hasBest   bool
}

func (e *enumerator) dfs(i int) {
	if i == e.n {
		e.commit()
		return
	}
	c := &e.in.Contracts[i]
	if c.Locked {
		if e.canPlace(i, c.Start) {
			e.place(i, c.Start)
			e.dfs(i + 1)
			e.unplace(i, c.Start)
		}
		return
	}
	e.dec[i] = true
	e.dfs(i + 1)
	e.dec[i] = false
	for _, st := range c.Starts {
		if !e.canPlace(i, st) {
			continue
		}
		e.place(i, st)
		e.dfs(i + 1)
		e.unplace(i, st)
	}
}

func (e *enumerator) canPlace(i int, st int) bool {
	c := &e.in.Contracts[i]
	if e.count+1 > e.in.MaxSelect {
		return false
	}
	if c.Group != "" && e.group[c.Group] {
		return false
	}
	for _, qid := range c.Prereqs {
		j := e.idx[qid]
		if e.dec[j] {
			if e.sel[j] < 0 {
				return false
			}
			if e.sel[j]+e.in.Contracts[j].Duration > st {
				return false
			}
		}
	}
	for p := st; p < st+c.Duration; p++ {
		for r := 0; r < e.in.Resources; r++ {
			if e.used[p][r]+c.Demand[r] > e.in.Capacity[p][r] {
				return false
			}
		}
	}
	return true
}

func (e *enumerator) place(i int, st int) {
	c := &e.in.Contracts[i]
	e.dec[i] = true
	e.sel[i] = st
	e.count++
	e.rev += c.Revenue
	e.usage += contractUsage(c)
	if c.Group != "" {
		e.group[c.Group] = true
	}
	for p := st; p < st+c.Duration; p++ {
		for r := 0; r < e.in.Resources; r++ {
			e.used[p][r] += c.Demand[r]
		}
	}
}

func (e *enumerator) unplace(i int, st int) {
	c := &e.in.Contracts[i]
	e.dec[i] = false
	e.sel[i] = -1
	e.count--
	e.rev -= c.Revenue
	e.usage -= contractUsage(c)
	if c.Group != "" {
		e.group[c.Group] = false
	}
	for p := st; p < st+c.Duration; p++ {
		for r := 0; r < e.in.Resources; r++ {
			e.used[p][r] -= c.Demand[r]
		}
	}
}

func (e *enumerator) commit() {
	for i := 0; i < e.n; i++ {
		if e.sel[i] < 0 {
			continue
		}
		for _, qid := range e.in.Contracts[i].Prereqs {
			j := e.idx[qid]
			if e.sel[j] < 0 || e.sel[j]+e.in.Contracts[j].Duration > e.sel[i] {
				return
			}
		}
	}
	e.feasible++
	if !e.hasBest || better(e.rev, e.usage, e.bestRev, e.bestUsage) {
		e.hasBest = true
		e.bestRev = e.rev
		e.bestUsage = e.usage
		e.best = make(map[string]int, e.count)
		for i := 0; i < e.n; i++ {
			if e.sel[i] >= 0 {
				e.best[e.in.Contracts[i].ID] = e.sel[i]
			}
		}
	}
}
