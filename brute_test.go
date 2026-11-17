package formal

import (
	"errors"
	"math/rand"
	"os"
	"reflect"
	"sort"
	"strconv"
	"testing"
)

// guaranteesFit reports whether every queue-guaranteed job can coexist with
// the mandatory (non-preemptible) jobs. Guarantee invariants are only
// checkable under this condition: an unprotected non-preemptible job may
// physically occupy guaranteed capacity that cannot be reclaimed.
func guaranteesFit(p *prepared) bool {
	left := p.capLeft
	for i := range p.jobs {
		if p.prot0[i] {
			left -= p.units[i]
		}
	}
	return left >= 0
}

// randomTree builds a valid random hierarchy: one or two levels below the
// root, guarantees satisfying sum(children) <= parent <= capacity.
func randomTree(r *rand.Rand) (*Tree, []string, int64) {
	twoLevel := r.Intn(2) == 0
	var leaves []*Node
	var roots []*Node
	mk := func(prefix string, n int) []*Node {
		out := []*Node{}
		for i := 0; i < n; i++ {
			g := int64(r.Intn(5))
			out = append(out, &Node{Name: prefix + string(rune('a'+i)), Guarantee: g})
		}
		return out
	}
	if twoLevel {
		nGroups := 1 + r.Intn(2)
		for gIdx := 0; gIdx < nGroups; gIdx++ {
			prefix := string(rune('p'+gIdx)) + "/"
			ls := mk(prefix, 1+r.Intn(2))
			var sum int64
			for _, l := range ls {
				sum += l.Guarantee
			}
			roots = append(roots, &Node{Name: string(rune('p' + gIdx)), Guarantee: sum + int64(r.Intn(3)), Children: ls})
			leaves = append(leaves, ls...)
		}
	} else {
		leaves = mk("", 1+r.Intn(3))
		roots = leaves
	}
	var rootG int64
	for _, c := range roots {
		rootG += c.Guarantee
	}
	capacity := rootG + int64(r.Intn(6))
	if capacity == 0 {
		capacity = int64(1 + r.Intn(8))
	}
	tree := &Tree{Root: &Node{Name: "root", Guarantee: rootG, Children: roots}}
	if len(roots) == 0 {
		tree.Root = &Node{Name: "root", Guarantee: capacity}
	}
	if err := tree.Validate(capacity); err != nil {
		panic(err)
	}
	paths := []string{}
	for p := range tree.leaves() {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if len(paths) == 0 {
		paths = []string{"root"}
	}
	return tree, paths, capacity
}

// randomInstance builds a small random planning input on the given tree.
func randomInstance(r *rand.Rand, tree *Tree, queues []string, capacity int64, maxJobs int) Input {
	n := r.Intn(maxJobs + 1)
	seqs := r.Perm(n)
	jobs := make([]Job, 0, n)
	for i := 0; i < n; i++ {
		j := Job{
			ID:             "j" + string(rune('a'+i)) + string(rune('0'+r.Intn(10))),
			Queue:          queues[r.Intn(len(queues))],
			Priority:       1 + r.Intn(3),
			Members:        int32(1 + r.Intn(3)),
			UnitsPerMember: int64(1 + r.Intn(2)),
			Seq:            uint64(seqs[i]),
			Preemptible:    true,
		}
		j.ID += string(rune('A' + i))
		if r.Intn(10) < 3 {
			j.Running = true
			j.CompletedWork = int64(r.Intn(50))
			if r.Intn(10) < 2 {
				j.Preemptible = false
			}
		}
		jobs = append(jobs, j)
	}
	return Input{Capacity: capacity, Tree: tree, Jobs: jobs}
}

// The exact planner must reproduce the exhaustive optimum precisely on small
// clusters: same score and, because the fairness tie-break is total, the
// same allocation.
func TestPlanMatchesBruteForce(t *testing.T) {
	stressPlanMatchesBruteForce(t, 400, 0)
}

// TestStressPlanMatchesBruteForce runs an extended randomized cross-check
// when QUOTA_STRESS_SEEDS is set, e.g. `QUOTA_STRESS_SEEDS=20000 go test`.
func TestStressPlanMatchesBruteForce(t *testing.T) {
	n, _ := strconv.Atoi(os.Getenv("QUOTA_STRESS_SEEDS"))
	if n == 0 {
		t.Skip("set QUOTA_STRESS_SEEDS to enable")
	}
	stressPlanMatchesBruteForce(t, n, 100000)
}

func stressPlanMatchesBruteForce(t *testing.T, seeds int, offset int64) {
	for s := 0; s < seeds; s++ {
		seed := offset + int64(s)
		r := rand.New(rand.NewSource(seed))
		tree, queues, capacity := randomTree(r)
		in := randomInstance(r, tree, queues, capacity, 6+int(seed%7))
		plan, err := Plan(in, nil)
		opt, berr := BruteForce(in)
		if err != nil || berr != nil {
			if errors.Is(err, ErrOverCapacity) && errors.Is(berr, ErrOverCapacity) {
				continue
			}
			t.Fatalf("seed %d: plan err %v, brute err %v", seed, err, berr)
		}
		if plan.Score.Compare(opt.Score) != 0 {
			t.Fatalf("seed %d: score %+v != optimal %+v", seed, plan.Score, opt.Score)
		}
		if !reflect.DeepEqual(idSet(plan.Allocated), idSet(opt.Allocated)) {
			t.Fatalf("seed %d: allocated %v != optimal %v", seed, ids(plan.Allocated), ids(opt.Allocated))
		}
		if err := Verify(in, plan); err != nil {
			t.Fatalf("seed %d: verify: %v", seed, err)
		}
	}
}

// Verify rejects a suboptimal plan: greedy first-fit takes the 6-unit gang
// and strands 4 units, while the optimum packs the two 5-unit gangs.
func TestVerifyDetectsSuboptimal(t *testing.T) {
	tree := &Tree{Root: intern("root", 10, leaf("a", 4))}
	big := job("big", "a", 1, 2, 1)
	big.Members = 3
	in := Input{
		Capacity: 10,
		Tree:     tree,
		Jobs:     []Job{big, job("g1", "a", 1, 5, 2), job("g2", "a", 1, 5, 3)},
	}
	greedy, err := Plan(in, &Options{MaxExactCells: 1})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if err := Verify(in, greedy); err == nil {
		t.Fatalf("expected Verify to reject suboptimal greedy plan %v", ids(greedy.Allocated))
	}
}

// On larger instances the plan must keep the structural invariants: capacity
// respected, gang jobs placed atomically, non-preemptible jobs kept, and
// every job covered by its own queue's guarantee allocated.
func TestPlanInvariants(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		r := rand.New(rand.NewSource(1000 + seed))
		tree, queues, capacity := randomTree(r)
		capacity += 100
		in := randomInstance(r, tree, queues, capacity, 40)
		plan, err := Plan(in, nil)
		if err != nil {
			if errors.Is(err, ErrOverCapacity) {
				continue
			}
			t.Fatalf("seed %d: %v", seed, err)
		}
		var used int64
		for _, j := range plan.Allocated {
			used += j.Units()
		}
		if used > in.Capacity {
			t.Fatalf("seed %d: over capacity %d > %d", seed, used, in.Capacity)
		}
		alloc := idSet(plan.Allocated)
		p, err := prepare(in)
		if err != nil {
			t.Fatalf("seed %d: prepare: %v", seed, err)
		}
		if guaranteesFit(p) {
			for i, j := range p.jobs {
				if p.prot0[i] && !alloc[j.ID] {
					t.Fatalf("seed %d: guaranteed job %s not allocated", seed, j.ID)
				}
			}
			for _, j := range in.Jobs {
				if j.Running && !j.Preemptible && !alloc[j.ID] {
					t.Fatalf("seed %d: non-preemptible job %s dropped", seed, j.ID)
				}
			}
		}
		again, err := Plan(in, nil)
		if err != nil {
			t.Fatalf("seed %d: replan: %v", seed, err)
		}
		if !reflect.DeepEqual(ids(plan.Allocated), ids(again.Allocated)) {
			t.Fatalf("seed %d: planning is not deterministic", seed)
		}
	}
}

// The greedy fallback keeps the guarantee and feasibility invariants even
// when the exact DP is disabled.
func TestGreedyFallbackInvariants(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		r := rand.New(rand.NewSource(2000 + seed))
		tree, queues, capacity := randomTree(r)
		in := randomInstance(r, tree, queues, capacity, 12)
		plan, err := Plan(in, &Options{MaxExactCells: 1})
		if err != nil {
			if errors.Is(err, ErrOverCapacity) {
				continue
			}
			t.Fatalf("seed %d: %v", seed, err)
		}
		var used int64
		for _, j := range plan.Allocated {
			used += j.Units()
		}
		if used > in.Capacity {
			t.Fatalf("seed %d: greedy over capacity", seed)
		}
		alloc := idSet(plan.Allocated)
		p, err := prepare(in)
		if err != nil {
			t.Fatalf("seed %d: prepare: %v", seed, err)
		}
		if guaranteesFit(p) {
			for i, j := range p.jobs {
				if p.prot0[i] && !alloc[j.ID] {
					t.Fatalf("seed %d: greedy dropped guaranteed job %s", seed, j.ID)
				}
			}
		}
	}
}

// Plan is a pure function: concurrent rounds on the same tree and input must
// not race and must agree.
func TestPlanConcurrent(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	tree, queues, capacity := randomTree(r)
	in := randomInstance(r, tree, queues, capacity, 12)
	want, err := Plan(in, nil)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	const workers = 8
	errs := make(chan string, workers)
	for w := 0; w < workers; w++ {
		go func() {
			got, err := Plan(in, nil)
			if err != nil {
				errs <- err.Error()
				return
			}
			if !reflect.DeepEqual(ids(got.Allocated), ids(want.Allocated)) {
				errs <- "concurrent plans disagree"
				return
			}
			errs <- ""
		}()
	}
	for w := 0; w < workers; w++ {
		if msg := <-errs; msg != "" {
			t.Fatalf("concurrent Plan: %s", msg)
		}
	}
}
