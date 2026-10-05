package joinopt

import (
	"math/big"
	"math/bits"
	"math/rand"
	"strings"
	"testing"
)

// chainABC is the hand-computed example from README.md:
// cards A=100, B=200, C=50; edges A-B (1000), B-C (500).
func chainABC(t *testing.T) *Problem {
	t.Helper()
	p, err := NewProblem(
		[]string{"A", "B", "C"},
		[]int64{100, 200, 50},
		[]Edge{{A: 0, B: 1, Card: 1000}, {A: 1, B: 2, Card: 500}},
	)
	if err != nil {
		t.Fatalf("NewProblem: %v", err)
	}
	return p
}

func ratInt(v int64) *big.Rat { return big.NewRat(v, 1) }

func TestEstimationFormula(t *testing.T) {
	d := NewDP(chainABC(t))
	ab, bc, abc := 0b011, 0b110, 0b111
	if d.Est[ab].Cmp(ratInt(1000)) != 0 {
		t.Errorf("est(AB) = %s, want 1000", d.Est[ab])
	}
	if d.Est[bc].Cmp(ratInt(500)) != 0 {
		t.Errorf("est(BC) = %s, want 500", d.Est[bc])
	}
	// est(ABC) = 100*200*50 * (1000/20000) * (500/10000) = 2500
	if d.Est[abc].Cmp(ratInt(2500)) != 0 {
		t.Errorf("est(ABC) = %s, want 2500", d.Est[abc])
	}
}

func TestHandComputedOptimum(t *testing.T) {
	d := NewDP(chainABC(t))
	best, ok := d.Optimal()
	if !ok {
		t.Fatal("no plan found")
	}
	// ((A⋈B)⋈C): 1000+2500 = 3500;  (A⋈(B⋈C)): 500+2500 = 3000.
	if best.Cost.Cmp(ratInt(3000)) != 0 {
		t.Errorf("cost = %s, want 3000", best.Cost)
	}
	if best.Canon != "((B ⋈ C) ⋈ A)" {
		t.Errorf("canon = %q, want %q", best.Canon, "((B ⋈ C) ⋈ A)")
	}
}

func TestEnumerationCount(t *testing.T) {
	want := []int{1, 1, 3, 15, 105, 945, 10395} // (2n-3)!!, n = 1..7
	for n := 1; n <= 7; n++ {
		if got := len(enumerateTrees(n)); got != want[n-1] {
			t.Errorf("n=%d: enumerated %d trees, want %d", n, got, want[n-1])
		}
	}
}

func randomProblem(r *rand.Rand, n int) *Problem {
	names := make([]string, n)
	cards := make([]int64, n)
	for i := range names {
		names[i] = string(rune('A' + i))
		cards[i] = 1 + r.Int63n(1000)
	}
	var edges []Edge
	have := map[[2]int]bool{}
	add := func(i, j int) {
		if i > j {
			i, j = j, i
		}
		if have[[2]int{i, j}] {
			return
		}
		have[[2]int{i, j}] = true
		edges = append(edges, Edge{A: i, B: j, Card: 1 + r.Int63n(cards[i]*cards[j])})
	}
	for i := 1; i < n; i++ { // random spanning tree keeps the graph connected
		add(i, r.Intn(i))
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if r.Float64() < 0.25 {
				add(i, j)
			}
		}
	}
	p, err := NewProblem(names, cards, edges)
	if err != nil {
		panic(err)
	}
	return p
}

func TestDPvsBruteForceRandom(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		r := rand.New(rand.NewSource(seed))
		n := 2 + r.Intn(6) // 2..7 tables
		p := randomProblem(r, n)
		d := NewDP(p)
		best, ok := d.Optimal()
		if !ok {
			t.Fatalf("seed %d: DP found no plan on a connected graph", seed)
		}
		br := d.BruteForce()
		if br.Trees != doubleFactorial(2*n-3) {
			t.Fatalf("seed %d: enumerated %d trees", seed, br.Trees)
		}
		if br.Valid == 0 || br.Best == nil {
			t.Fatalf("seed %d: brute force found no valid tree", seed)
		}
		if br.Best.Cost.Cmp(best.Cost) != 0 {
			t.Errorf("seed %d (n=%d): DP cost %s != brute cost %s", seed, n, best.Cost, br.Best.Cost)
		}
		if br.Best.Canon != best.Canon {
			t.Errorf("seed %d (n=%d): DP plan %q != brute plan %q", seed, n, best.Canon, br.Best.Canon)
		}
	}
}

func doubleFactorial(k int) int {
	v := 1
	for ; k > 1; k -= 2 {
		v *= k
	}
	return v
}

func TestDisconnectedGraph(t *testing.T) {
	p, err := NewProblem(
		[]string{"A", "B", "C", "D"},
		[]int64{10, 10, 10, 10},
		[]Edge{{A: 0, B: 1, Card: 5}, {A: 2, B: 3, Card: 5}},
	)
	if err != nil {
		t.Fatalf("NewProblem: %v", err)
	}
	d := NewDP(p)
	if _, ok := d.Optimal(); ok {
		t.Error("Optimal succeeded on a disconnected graph")
	}
	br := d.BruteForce()
	if br.Valid != 0 || br.Best != nil {
		t.Errorf("brute force: valid=%d, want 0", br.Valid)
	}
}

func TestSymmetricTriangleCanonical(t *testing.T) {
	p, err := NewProblem(
		[]string{"A", "B", "C"},
		[]int64{10, 10, 10},
		[]Edge{{A: 0, B: 1, Card: 10}, {A: 0, B: 2, Card: 10}, {A: 1, B: 2, Card: 10}},
	)
	if err != nil {
		t.Fatalf("NewProblem: %v", err)
	}
	d := NewDP(p)
	best, ok := d.Optimal()
	if !ok {
		t.Fatal("no plan")
	}
	// est(pair) = 10, est(ABC) = 1000 * (1/10)^3 = 1, cost = 10 + 1 = 11.
	if best.Cost.Cmp(ratInt(11)) != 0 {
		t.Errorf("cost = %s, want 11", best.Cost)
	}
	if best.Canon != "((A ⋈ B) ⋈ C)" {
		t.Errorf("canon = %q, want %q", best.Canon, "((A ⋈ B) ⋈ C)")
	}
	if got := d.Est[0b111]; got.Cmp(ratInt(1)) != 0 {
		t.Errorf("est(ABC) = %s, want 1", got)
	}
}

// TestPlanInvariants checks structural properties of DP plans on random
// instances: canonical child order, cost consistency, and edge validity.
func TestPlanInvariants(t *testing.T) {
	for seed := int64(100); seed < 115; seed++ {
		r := rand.New(rand.NewSource(seed))
		p := randomProblem(r, 2+r.Intn(8))
		d := NewDP(p)
		best, ok := d.Optimal()
		if !ok {
			t.Fatalf("seed %d: no plan", seed)
		}
		checkPlan(t, d, best)
	}
}

func checkPlan(t *testing.T, d *DP, pl *Plan) {
	t.Helper()
	if pl.Left == nil {
		if bits.OnesCount(uint(pl.Mask)) != 1 || pl.Cost.Sign() != 0 {
			t.Errorf("bad leaf plan %+v", pl)
		}
		return
	}
	if pl.Left.Canon > pl.Right.Canon {
		t.Errorf("children not canonically ordered: %q > %q", pl.Left.Canon, pl.Right.Canon)
	}
	if pl.Canon != canonJoin(pl.Left.Canon, pl.Right.Canon) {
		t.Errorf("canon %q inconsistent with children", pl.Canon)
	}
	if pl.Mask != pl.Left.Mask|pl.Right.Mask || pl.Left.Mask&pl.Right.Mask != 0 {
		t.Errorf("mask inconsistency at %q", pl.Canon)
	}
	if d.nbr[pl.Left.Mask]&pl.Right.Mask == 0 {
		t.Errorf("join without a declared edge at %q", pl.Canon)
	}
	want := new(big.Rat).Add(pl.Left.Cost, pl.Right.Cost)
	want.Add(want, d.Est[pl.Mask])
	if pl.Cost.Cmp(want) != 0 {
		t.Errorf("cost %s != %s at %q", pl.Cost, want, pl.Canon)
	}
	checkPlan(t, d, pl.Left)
	checkPlan(t, d, pl.Right)
}

func TestValidationErrors(t *testing.T) {
	names := []string{"A", "B", "C"}
	cards := []int64{10, 20, 30}
	many := make([]string, MaxTables+1)
	for i := range many {
		many[i] = string(rune('a' + i))
	}
	cases := []struct {
		name  string
		names []string
		cards []int64
		edges []Edge
	}{
		{"no tables", nil, nil, nil},
		{"too many tables", many, make([]int64, MaxTables+1), nil},
		{"card mismatch", names, []int64{1}, nil},
		{"empty name", []string{"", "B"}, []int64{1, 1}, nil},
		{"duplicate name", []string{"A", "A"}, []int64{1, 1}, nil},
		{"zero card", names, []int64{0, 1, 1}, nil},
		{"self edge", names, cards, []Edge{{A: 1, B: 1, Card: 1}}},
		{"index out of range", names, cards, []Edge{{A: 0, B: 3, Card: 1}}},
		{"negative index", names, cards, []Edge{{A: -1, B: 0, Card: 1}}},
		{"duplicate edge", names, cards, []Edge{{A: 0, B: 1, Card: 1}, {A: 1, B: 0, Card: 1}}},
		{"zero edge card", names, cards, []Edge{{A: 0, B: 1, Card: 0}}},
		{"edge card too big", names, cards, []Edge{{A: 0, B: 1, Card: 201}}},
	}
	for _, c := range cases {
		if _, err := NewProblem(c.names, c.cards, c.edges); err == nil {
			t.Errorf("%s: expected error, got nil", c.name)
		}
	}
}

func TestParseJSON(t *testing.T) {
	doc := `{
	  "tables": [{"name": "A", "card": 100}, {"name": "B", "card": 200}, {"name": "C", "card": 50}],
	  "edges": [{"a": "A", "b": "B", "card": 1000}, {"a": 1, "b": 2, "card": 500}]
	}`
	p, err := Parse(strings.NewReader(doc))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	best, ok := NewDP(p).Optimal()
	if !ok || best.Cost.Cmp(ratInt(3000)) != 0 {
		t.Errorf("parsed problem: cost=%v ok=%v, want 3000", best.Cost, ok)
	}

	for _, doc := range []string{
		`{not json`,
		`{"tables": []}`,
		`{"tables": [{"name": "A", "card": 1}], "edges": [{"a": "A", "b": "ZZZ", "card": 1}]}`,
		`{"tables": [{"name": "A", "card": 1}], "edges": [{"a": 0.5, "b": 0, "card": 1}]}`,
	} {
		if _, err := Parse(strings.NewReader(doc)); err == nil {
			t.Errorf("Parse(%s): expected error", doc)
		}
	}
}

func TestRunCLI(t *testing.T) {
	doc := `{
	  "tables": [{"name": "A", "card": 100}, {"name": "B", "card": 200}, {"name": "C", "card": 50}],
	  "edges": [{"a": 0, "b": 1, "card": 1000}, {"a": 1, "b": 2, "card": 500}]
	}`
	var out, errOut strings.Builder
	code := RunCLI([]string{"-verify"}, strings.NewReader(doc), &out, &errOut)
	if code != 0 {
		t.Fatalf("exit code %d, stderr: %s", code, errOut.String())
	}
	for _, want := range []string{
		"optimal cost: 3000",
		"canonical plan: ((B ⋈ C) ⋈ A)",
		"certificates",
		"enumerated 3 binary trees, 2 satisfy",
		"verification: PASS",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q:\n%s", want, out.String())
		}
	}
	var certLine string
	for _, line := range strings.Split(out.String(), "\n") {
		if strings.Contains(line, "{A, B, C}") {
			certLine = line
		}
	}
	if !strings.Contains(certLine, "2500") || !strings.Contains(certLine, "3000") {
		t.Errorf("certificate line for full set missing est/cost: %q", certLine)
	}
}

func TestRunCLIDisconnected(t *testing.T) {
	doc := `{
	  "tables": [{"name": "A", "card": 10}, {"name": "B", "card": 10}],
	  "edges": []
	}`
	var out strings.Builder
	if code := RunCLI(nil, strings.NewReader(doc), &out, &out); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if !strings.Contains(out.String(), "not connected") {
		t.Errorf("output should report disconnection:\n%s", out.String())
	}
}

func TestRunCLIBadInput(t *testing.T) {
	var out strings.Builder
	if code := RunCLI(nil, strings.NewReader(`{bad`), &out, &out); code != 2 {
		t.Errorf("exit code = %d, want 2", code)
	}
}
