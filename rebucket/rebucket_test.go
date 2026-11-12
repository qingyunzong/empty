package rebucket_test

import (
	"math/big"
	"math/rand"
	"testing"

	"example.org/dataeng/q0110/rebucket"
)

func rat(num, den int64) *big.Rat {
	return big.NewRat(num, den)
}

func rats(vals ...int64) []*big.Rat {
	out := make([]*big.Rat, len(vals))
	for i, v := range vals {
		out[i] = big.NewRat(v, 1)
	}
	return out
}

func massesString(res *rebucket.Result) string {
	s := "["
	for i, m := range res.Masses {
		if i > 0 {
			s += " "
		}
		s += m.RatString()
	}
	return s + "] left=" + res.LeftOverflow.RatString() + " right=" + res.RightOverflow.RatString()
}

func requireMasses(t *testing.T, res *rebucket.Result, want ...*big.Rat) {
	t.Helper()
	if len(res.Masses) != len(want) {
		t.Fatalf("got %d masses, want %d", len(res.Masses), len(want))
	}
	for i, w := range want {
		if res.Masses[i].Cmp(w) != 0 {
			t.Fatalf("mass[%d] = %s, want %s (full: %s)", i, res.Masses[i], w, massesString(res))
		}
	}
}

// A source bucket straddling a target boundary must be split by true
// overlap length, not dumped into the bucket containing its midpoint.
func TestProportionalSplitNotMidpoint(t *testing.T) {
	old := []rebucket.Bucket{rebucket.NewBucket(rat(0, 1), rat(2, 1), 2)}
	res, err := rebucket.Rebucket(old, []*big.Rat{rat(0, 1), rat(1, 2), rat(2, 1)})
	if err != nil {
		t.Fatal(err)
	}
	// Uniform density 1 over [0,2): [0,1/2) gets 1/2, [1/2,2) gets 3/2.
	// A midpoint rule would wrongly report [0, 2].
	requireMasses(t, res, rat(1, 2), rat(3, 2))
	if res.LeftOverflow.Sign() != 0 || res.RightOverflow.Sign() != 0 {
		t.Fatalf("unexpected overflow: %s", massesString(res))
	}
}

func TestZeroWidthBucketRejected(t *testing.T) {
	old := []rebucket.Bucket{rebucket.NewBucket(rat(1, 1), rat(1, 1), 5)}
	if _, err := rebucket.Rebucket(old, rats(0, 2)); err == nil {
		t.Fatal("zero-width bucket accepted")
	}
	inverted := []rebucket.Bucket{rebucket.NewBucket(rat(2, 1), rat(1, 1), 5)}
	if _, err := rebucket.Rebucket(inverted, rats(0, 3)); err == nil {
		t.Fatal("inverted bucket accepted")
	}
}

func TestValidationErrors(t *testing.T) {
	good := []rebucket.Bucket{rebucket.NewBucket(rat(0, 1), rat(1, 1), 1)}
	cases := []struct {
		name   string
		old    []rebucket.Bucket
		bounds []*big.Rat
	}{
		{"too few bounds", good, rats(0)},
		{"no bounds", good, nil},
		{"equal bounds", good, rats(0, 0)},
		{"decreasing bounds", good, rats(2, 0)},
		{"nil bound", good, []*big.Rat{rat(0, 1), nil}},
		{"overlapping buckets", []rebucket.Bucket{
			rebucket.NewBucket(rat(0, 1), rat(2, 1), 1),
			rebucket.NewBucket(rat(1, 1), rat(3, 1), 1),
		}, rats(0, 3)},
		{"negative mass", []rebucket.Bucket{{
			Left: rat(0, 1), Right: rat(1, 1), Mass: big.NewRat(-1, 1),
		}}, rats(0, 1)},
		{"nil field", []rebucket.Bucket{{Left: nil, Right: rat(1, 1), Mass: big.NewRat(1, 1)}}, rats(0, 1)},
	}
	for _, tc := range cases {
		if _, err := rebucket.Rebucket(tc.old, tc.bounds); err == nil {
			t.Errorf("%s: expected error, got nil", tc.name)
		}
	}
}

// Negative endpoints and holes between source buckets are legal.
func TestNegativeEndpointsAndGaps(t *testing.T) {
	old := []rebucket.Bucket{
		rebucket.NewBucket(rat(-3, 1), rat(-1, 1), 4), // density 2
		rebucket.NewBucket(rat(1, 1), rat(2, 1), 2),   // density 2, gap [-1,1)
	}
	res, err := rebucket.Rebucket(old, rats(-2, 0, 3))
	if err != nil {
		t.Fatal(err)
	}
	requireMasses(t, res, rat(2, 1), rat(2, 1))
	if res.LeftOverflow.Cmp(rat(2, 1)) != 0 || res.RightOverflow.Sign() != 0 {
		t.Fatalf("bad overflow: %s", massesString(res))
	}
	if res.Total().Cmp(rat(6, 1)) != 0 {
		t.Fatalf("total = %s, want 6", res.Total())
	}
}

// A target boundary coinciding with a source endpoint must attribute the
// mass to the correct side under half-open semantics.
func TestEndpointAttribution(t *testing.T) {
	old := []rebucket.Bucket{
		rebucket.NewBucket(rat(0, 1), rat(1, 1), 1),
		rebucket.NewBucket(rat(1, 1), rat(3, 1), 4),
	}
	res, err := rebucket.Rebucket(old, rats(0, 1, 3))
	if err != nil {
		t.Fatal(err)
	}
	requireMasses(t, res, rat(1, 1), rat(4, 1))

	// Window starting exactly at the shared endpoint: [0,1) overflows left.
	res, err = rebucket.Rebucket(old, rats(1, 3))
	if err != nil {
		t.Fatal(err)
	}
	requireMasses(t, res, rat(4, 1))
	if res.LeftOverflow.Cmp(rat(1, 1)) != 0 || res.RightOverflow.Sign() != 0 {
		t.Fatalf("bad overflow: %s", massesString(res))
	}
}

// gridReference recomputes the redistribution on a fine rational grid.
// Every source endpoint and target boundary is a multiple of the grid
// step, so each cell lies fully inside exactly one source bucket (or a
// gap) and exactly one target region. A cell is attributed by its left
// edge, which encodes the half-open [lo, hi) convention.
func gridReference(t *testing.T, old []rebucket.Bucket, bounds []*big.Rat) *rebucket.Result {
	t.Helper()

	lcm := big.NewInt(1)
	mul := func(r *big.Rat) {
		d := r.Denom()
		g := new(big.Int).GCD(nil, nil, lcm, d)
		lcm.Mul(lcm, d).Quo(lcm, g)
	}
	lo := new(big.Rat).Set(bounds[0])
	hi := new(big.Rat).Set(bounds[len(bounds)-1])
	for _, b := range old {
		mul(b.Left)
		mul(b.Right)
		if b.Left.Cmp(lo) < 0 {
			lo.Set(b.Left)
		}
		if b.Right.Cmp(hi) > 0 {
			hi.Set(b.Right)
		}
	}
	for _, b := range bounds {
		mul(b)
	}
	step := new(big.Rat).SetFrac(big.NewInt(1), lcm)

	res := &rebucket.Result{
		Masses:        make([]*big.Rat, len(bounds)-1),
		LeftOverflow:  new(big.Rat),
		RightOverflow: new(big.Rat),
	}
	for i := range res.Masses {
		res.Masses[i] = new(big.Rat)
	}

	for x := new(big.Rat).Set(lo); x.Cmp(hi) < 0; x.Add(x, step) {
		xNext := new(big.Rat).Add(x, step)
		var cellMass *big.Rat
		for _, b := range old {
			if b.Left.Cmp(x) <= 0 && xNext.Cmp(b.Right) <= 0 {
				width := new(big.Rat).Sub(b.Right, b.Left)
				density := new(big.Rat).Quo(b.Mass, width)
				cellMass = new(big.Rat).Mul(density, step)
				break
			}
		}
		if cellMass == nil {
			continue // gap cell carries no mass
		}
		switch {
		case x.Cmp(bounds[0]) < 0:
			res.LeftOverflow.Add(res.LeftOverflow, cellMass)
		case x.Cmp(bounds[len(bounds)-1]) >= 0:
			res.RightOverflow.Add(res.RightOverflow, cellMass)
		default:
			for i := 0; i < len(bounds)-1; i++ {
				if bounds[i].Cmp(x) <= 0 && x.Cmp(bounds[i+1]) < 0 {
					res.Masses[i].Add(res.Masses[i], cellMass)
					break
				}
			}
		}
	}
	return res
}

func requireSameResult(t *testing.T, got, want *rebucket.Result) {
	t.Helper()
	if got.LeftOverflow.Cmp(want.LeftOverflow) != 0 ||
		got.RightOverflow.Cmp(want.RightOverflow) != 0 ||
		len(got.Masses) != len(want.Masses) {
		t.Fatalf("got %s, want %s", massesString(got), massesString(want))
	}
	for i := range got.Masses {
		if got.Masses[i].Cmp(want.Masses[i]) != 0 {
			t.Fatalf("mass[%d]: got %s, want %s", i, massesString(got), massesString(want))
		}
	}
}

// Randomized cross-check against the fine rational grid: exact equality
// of every target bucket and both overflows (hence mass conservation and
// correct half-open endpoint attribution).
func TestGridReferenceAndConservation(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for trial := 0; trial < 300; trial++ {
		// Source buckets on a k/2 grid in [-6, 6], gaps allowed.
		points := rng.Perm(13)[:2*rng.Intn(4)+2]
		var halved []int
		for _, p := range points {
			halved = append(halved, p-6)
		}
		sortInts(halved)
		var old []rebucket.Bucket
		totalMass := new(big.Rat)
		for i := 0; i+1 < len(halved); i += 2 {
			m := int64(rng.Intn(10))
			old = append(old, rebucket.NewBucket(rat(int64(halved[i]), 2), rat(int64(halved[i+1]), 2), m))
			totalMass.Add(totalMass, big.NewRat(m, 1))
		}
		// Target bounds: 2..5 distinct sorted k/2 points in [-7, 7].
		nB := 2 + rng.Intn(4)
		seen := map[int]bool{}
		var bVals []int
		for len(bVals) < nB {
			v := rng.Intn(15) - 7
			if !seen[v] {
				seen[v] = true
				bVals = append(bVals, v)
			}
		}
		sortInts(bVals)
		bounds := make([]*big.Rat, nB)
		for i, v := range bVals {
			bounds[i] = rat(int64(v), 2)
		}

		got, err := rebucket.Rebucket(old, bounds)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if got.Total().Cmp(totalMass) != 0 {
			t.Fatalf("trial %d: conservation broken, total %s want %s (%s)",
				trial, got.Total(), totalMass, massesString(got))
		}
		requireSameResult(t, got, gridReference(t, old, bounds))
	}
}

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

// Re-bucketing twice through an intermediate coarser grid is not
// required to equal direct projection, and in general does not: the
// intermediate step homogenizes each merged bucket.
func TestDoubleRebucketDiffersFromDirect(t *testing.T) {
	old := []rebucket.Bucket{
		rebucket.NewBucket(rat(0, 1), rat(1, 1), 1),
		rebucket.NewBucket(rat(1, 1), rat(2, 1), 3),
	}
	direct, err := rebucket.Rebucket(old, rats(0, 1, 2))
	if err != nil {
		t.Fatal(err)
	}
	requireMasses(t, direct, rat(1, 1), rat(3, 1))

	coarse, err := rebucket.Rebucket(old, rats(0, 2))
	if err != nil {
		t.Fatal(err)
	}
	requireMasses(t, coarse, rat(4, 1))

	twice, err := rebucket.Rebucket(coarse.Buckets(rats(0, 2)), rats(0, 1, 2))
	if err != nil {
		t.Fatal(err)
	}
	requireMasses(t, twice, rat(2, 1), rat(2, 1))

	if twice.Masses[0].Cmp(direct.Masses[0]) == 0 && twice.Masses[1].Cmp(direct.Masses[1]) == 0 {
		t.Fatal("expected double re-bucketing to differ from direct projection")
	}
	t.Logf("direct: %s; twice via [0,2): %s", massesString(direct), massesString(twice))
}
