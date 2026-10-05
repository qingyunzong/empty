package sched

import (
	"fmt"
	"sort"
	"strings"
)

// Task is one scheduled job occurrence on the machine timeline.
type Task struct {
	JobID string
	Class int
	Setup int // setup time incurred before this job (from previous class)
	Start int // time the job itself starts processing
	End   int // completion time
}

// Schedule is a complete solution.
type Schedule struct {
	Tasks []Task // in chronological order
	Lmax  int    // maximum lateness max(C_j - Due_j)
	SumC  int    // total completion time sum(C_j)
	Exact bool   // true if proven optimal by exhaustive search
}

// Solve validates the instance and computes the best schedule it can.
// For up to ExactLimit jobs it enumerates every precedence-feasible
// permutation (exact optimum). For larger instances it uses beam search
// and the result is a feasible, not necessarily optimal, schedule.
func Solve(in *Instance) (*Schedule, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	p := newProblem(in)
	if len(in.Jobs) <= ExactLimit {
		return p.solveExact(), nil
	}
	return p.solveBeam(512), nil
}

// problem holds indexed, ready-to-search instance data.
type problem struct {
	n      int
	proc   []int
	rel    []int
	due    []int
	class  []int
	indeg  []int   // number of predecessors per job
	succ   [][]int // adjacency: job -> jobs it unblocks
	setups [][]int
	ids    []string
	totalP int
}

func newProblem(in *Instance) *problem {
	n := len(in.Jobs)
	p := &problem{
		n:      n,
		proc:   make([]int, n),
		rel:    make([]int, n),
		due:    make([]int, n),
		class:  make([]int, n),
		indeg:  make([]int, n),
		succ:   make([][]int, n),
		setups: in.Setups,
		ids:    make([]string, n),
	}
	idx := make(map[string]int, n)
	for i, j := range in.Jobs {
		idx[j.ID] = i
		p.proc[i] = j.Proc
		p.rel[i] = j.Rel
		p.due[i] = j.Due
		p.class[i] = j.Class
		p.ids[i] = j.ID
		p.totalP += j.Proc
	}
	for i, j := range in.Jobs {
		p.indeg[i] = len(j.Pred)
		for _, pre := range j.Pred {
			p.succ[idx[pre]] = append(p.succ[idx[pre]], i)
		}
	}
	return p
}

// setupOf returns the setup cost of running class c after class prev
// (prev == -1 means the machine is idle/fresh: no setup).
func (p *problem) setupOf(prev, c int) int {
	if prev < 0 || len(p.setups) == 0 {
		return 0
	}
	return p.setups[prev][c]
}

// state is a partial schedule during search.
type state struct {
	avail []bool // jobs whose predecessors are all scheduled
	left  int    // jobs not yet scheduled
	indeg []int
	now   int // machine free time
	prev  int // class of last scheduled job, -1 if none
	lmax  int
	sumC  int
	order []int // scheduled job indices in order
}

func (p *problem) initialState() *state {
	indeg := make([]int, p.n)
	copy(indeg, p.indeg)
	avail := make([]bool, p.n)
	for i := range avail {
		avail[i] = indeg[i] == 0
	}
	return &state{
		avail: avail,
		left:  p.n,
		indeg: indeg,
		prev:  -1,
		lmax:  -1 << 60,
	}
}

// place schedules job j after the current partial schedule, returning
// the new machine state fields (without mutating s).
func (p *problem) place(s *state, j int) (now, lmax, sumC int) {
	setup := p.setupOf(s.prev, p.class[j])
	start := s.now + setup
	if p.rel[j] > start {
		start = p.rel[j]
	}
	end := start + p.proc[j]
	lmax = s.lmax
	if l := end - p.due[j]; l > lmax {
		lmax = l
	}
	return end, lmax, s.sumC + end
}

// better compares two complete (or comparable partial) objective pairs
// lexicographically: Lmax first, then SumC.
func better(lmax1, sumC1, lmax2, sumC2 int) bool {
	return lmax1 < lmax2 || (lmax1 == lmax2 && sumC1 < sumC2)
}

// solveExact enumerates all precedence-feasible permutations with
// branch-and-bound pruning on the lexicographic objective.
func (p *problem) solveExact() *Schedule {
	bestL, bestS := 1<<60, 1<<60
	var bestOrder []int

	var rec func(s *state)
	rec = func(s *state) {
		if s.left == 0 {
			if better(s.lmax, s.sumC, bestL, bestS) {
				bestL, bestS = s.lmax, s.sumC
				bestOrder = append([]int(nil), s.order...)
			}
			return
		}
		// Prune: partial Lmax can only grow; if it already exceeds the
		// best complete Lmax this branch cannot win. On ties, the
		// partial SumC is a lower bound for the final SumC.
		if s.lmax > bestL || (s.lmax == bestL && s.sumC > bestS) {
			return
		}
		for j := 0; j < p.n; j++ {
			if !s.avail[j] {
				continue
			}
			now, lmax, sumC := p.place(s, j)
			ns := &state{
				avail: append([]bool(nil), s.avail...),
				left:  s.left - 1,
				indeg: append([]int(nil), s.indeg...),
				now:   now,
				prev:  p.class[j],
				lmax:  lmax,
				sumC:  sumC,
				order: append(append([]int(nil), s.order...), j),
			}
			ns.avail[j] = false
			for _, k := range p.succ[j] {
				ns.indeg[k]--
				if ns.indeg[k] == 0 {
					ns.avail[k] = true
				}
			}
			rec(ns)
		}
	}
	rec(p.initialState())
	return p.buildSchedule(bestOrder, true)
}

// solveBeam keeps the width best partial schedules per depth, ranked by
// (partial Lmax, partial SumC + a lower-bound estimate of remaining work).
func (p *problem) solveBeam(width int) *Schedule {
	type node struct {
		s     *state
		score int
	}
	level := []node{{s: p.initialState()}}
	for depth := 0; depth < p.n; depth++ {
		var next []node
		for _, nd := range level {
			s := nd.s
			for j := 0; j < p.n; j++ {
				if !s.avail[j] {
					continue
				}
				now, lmax, sumC := p.place(s, j)
				ns := &state{
					avail: append([]bool(nil), s.avail...),
					left:  s.left - 1,
					indeg: append([]int(nil), s.indeg...),
					now:   now,
					prev:  p.class[j],
					lmax:  lmax,
					sumC:  sumC,
					order: append(append([]int(nil), s.order...), j),
				}
				ns.avail[j] = false
				for _, k := range p.succ[j] {
					ns.indeg[k]--
					if ns.indeg[k] == 0 {
						ns.avail[k] = true
					}
				}
				next = append(next, node{s: ns, score: sumC + ns.left*now})
			}
		}
		sort.Slice(next, func(a, b int) bool {
			la, lb := next[a].s.lmax, next[b].s.lmax
			if la != lb {
				return la < lb
			}
			return next[a].score < next[b].score
		})
		if len(next) > width {
			next = next[:width]
		}
		level = next
	}
	best := level[0].s
	for _, nd := range level[1:] {
		if better(nd.s.lmax, nd.s.sumC, best.lmax, best.sumC) {
			best = nd.s
		}
	}
	return p.buildSchedule(best.order, false)
}

// buildSchedule materializes a job order into a Schedule with tasks.
func (p *problem) buildSchedule(order []int, exact bool) *Schedule {
	sc := &Schedule{Exact: exact, Lmax: -1 << 60}
	now, prev := 0, -1
	for _, j := range order {
		setup := p.setupOf(prev, p.class[j])
		start := now + setup
		if p.rel[j] > start {
			start = p.rel[j]
		}
		end := start + p.proc[j]
		sc.Tasks = append(sc.Tasks, Task{
			JobID: p.ids[j],
			Class: p.class[j],
			Setup: setup,
			Start: start,
			End:   end,
		})
		if l := end - p.due[j]; l > sc.Lmax {
			sc.Lmax = l
		}
		sc.SumC += end
		now, prev = end, p.class[j]
	}
	return sc
}

// Verify checks that sc is a feasible schedule for in: every job appears
// exactly once, release times and precedence constraints hold, tasks do
// not overlap, and setups match the class transition matrix. It also
// recomputes the objective values and compares them with sc.
func (in *Instance) Verify(sc *Schedule) error {
	if err := in.Validate(); err != nil {
		return err
	}
	p := newProblem(in)
	idx := make(map[string]int, p.n)
	for i, id := range p.ids {
		idx[id] = i
	}
	if len(sc.Tasks) != p.n {
		return fmt.Errorf("sched: schedule has %d tasks, want %d", len(sc.Tasks), p.n)
	}
	seen := make(map[string]bool, p.n)
	done := make(map[string]int, p.n) // job ID -> completion time
	now, prev := 0, -1
	lmax, sumC := -1<<60, 0
	for pos, t := range sc.Tasks {
		j, ok := idx[t.JobID]
		if !ok {
			return fmt.Errorf("sched: task %d references unknown job %q", pos, t.JobID)
		}
		if seen[t.JobID] {
			return fmt.Errorf("sched: job %q scheduled more than once", t.JobID)
		}
		seen[t.JobID] = true
		if t.Class != p.class[j] {
			return fmt.Errorf("sched: task %q has class %d, want %d", t.JobID, t.Class, p.class[j])
		}
		if want := p.setupOf(prev, t.Class); t.Setup != want {
			return fmt.Errorf("sched: task %q has setup %d, want %d", t.JobID, t.Setup, want)
		}
		if t.Start < now+t.Setup {
			return fmt.Errorf("sched: task %q starts at %d before machine+setup ready at %d", t.JobID, t.Start, now+t.Setup)
		}
		if t.Start < p.rel[j] {
			return fmt.Errorf("sched: task %q starts at %d before release %d", t.JobID, t.Start, p.rel[j])
		}
		if t.End != t.Start+p.proc[j] {
			return fmt.Errorf("sched: task %q ends at %d, want %d", t.JobID, t.End, t.Start+p.proc[j])
		}
		for _, pre := range in.Jobs[j].Pred {
			c, ok := done[pre]
			if !ok {
				return fmt.Errorf("sched: job %q scheduled before predecessor %q", t.JobID, pre)
			}
			if c > t.Start {
				return fmt.Errorf("sched: job %q starts at %d before predecessor %q completes at %d", t.JobID, t.Start, pre, c)
			}
		}
		done[t.JobID] = t.End
		if l := t.End - p.due[j]; l > lmax {
			lmax = l
		}
		sumC += t.End
		now, prev = t.End, t.Class
	}
	if lmax != sc.Lmax || sumC != sc.SumC {
		return fmt.Errorf("sched: objective mismatch: schedule claims (Lmax=%d, SumC=%d), computed (Lmax=%d, SumC=%d)",
			sc.Lmax, sc.SumC, lmax, sumC)
	}
	return nil
}

// Render returns a human-readable timeline of the schedule.
func (sc *Schedule) Render() string {
	var b strings.Builder
	mode := "heuristic (beam search)"
	if sc.Exact {
		mode = "exact (exhaustive)"
	}
	fmt.Fprintf(&b, "mode: %s\n", mode)
	for _, t := range sc.Tasks {
		fmt.Fprintf(&b, "[%4d-%4d] %-8s class=%d setup=%d\n", t.Start, t.End, t.JobID, t.Class, t.Setup)
	}
	fmt.Fprintf(&b, "Lmax=%d SumC=%d\n", sc.Lmax, sc.SumC)
	return b.String()
}
