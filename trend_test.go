package trend

import (
	"math/big"
	"testing"
)

func rat(t *testing.T, s string) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("bad rational %q", s)
	}
	return r
}

func TestKnownRegression(t *testing.T) {
	// y = 2x + 1 exactly.
	ix := NewIndex()
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 3, Samples: []Sample{{0, 1}, {1, 3}, {2, 5}}},
	}}); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Query(1, 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 3 {
		t.Fatalf("count = %d, want 3", st.Count)
	}
	if st.Slope.Cmp(rat(t, "2")) != 0 {
		t.Fatalf("slope = %v, want 2", st.Slope)
	}
	if st.Intercept.Cmp(rat(t, "1")) != 0 {
		t.Fatalf("intercept = %v, want 1", st.Intercept)
	}
	if st.RSS.Sign() != 0 {
		t.Fatalf("rss = %v, want 0", st.RSS)
	}
}

func TestFractionalSlopeAndRSS(t *testing.T) {
	// Points (0,0), (1,0), (2,1): slope 1/2, intercept -1/3,
	// residuals 1/3, -1/6... verify via exact fractions.
	ix := NewIndex()
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 3, Samples: []Sample{{0, 0}, {1, 0}, {2, 1}}},
	}}); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Query(1, 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if st.Slope.Cmp(rat(t, "1/2")) != 0 {
		t.Fatalf("slope = %v, want 1/2", st.Slope)
	}
	if st.Intercept.Cmp(rat(t, "-1/6")) != 0 {
		t.Fatalf("intercept = %v, want -1/6", st.Intercept)
	}
	// residuals: 0-(-1/6)=1/6, 0-(1/3)=-1/3, 1-(5/6)=1/6 -> rss = 1/36+1/9+1/36 = 1/6
	if st.RSS.Cmp(rat(t, "1/6")) != 0 {
		t.Fatalf("rss = %v, want 1/6", st.RSS)
	}
}

func TestDuplicateTimestampsZeroVariance(t *testing.T) {
	ix := NewIndex()
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 5, To: 6, Samples: []Sample{{5, 1}, {5, 2}, {5, 4}}},
	}}); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Query(1, 5, 5)
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 3 {
		t.Fatalf("count = %d, want 3", st.Count)
	}
	if st.Slope != nil || st.Intercept != nil {
		t.Fatalf("zero variance must return no slope, got %v", st)
	}
	// mean = 7/3; rss = (1-7/3)^2 + (2-7/3)^2 + (4-7/3)^2 = 16/9+1/9+25/9 = 14/3
	if st.RSS.Cmp(rat(t, "14/3")) != 0 {
		t.Fatalf("rss = %v, want 14/3", st.RSS)
	}
}

func TestSinglePointNoSlope(t *testing.T) {
	ix := NewIndex()
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 1, Samples: []Sample{{0, 7}}},
	}}); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Query(1, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 1 || st.Slope != nil || st.RSS.Sign() != 0 {
		t.Fatalf("single point: got %v", st)
	}
}

func TestEdgeInterpolationFractions(t *testing.T) {
	// Samples (0,0) and (10,5); query [3,7] interpolates (3,3/2) and (7,7/2).
	ix := NewIndex()
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 11, Samples: []Sample{{0, 0}, {10, 5}}},
	}}); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Query(1, 3, 7)
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 2 {
		t.Fatalf("count = %d, want 2", st.Count)
	}
	if st.Slope.Cmp(rat(t, "1/2")) != 0 {
		t.Fatalf("slope = %v, want 1/2", st.Slope)
	}
	if st.Intercept.Cmp(rat(t, "0")) != 0 {
		t.Fatalf("intercept = %v, want 0", st.Intercept)
	}
	if st.RSS.Sign() != 0 {
		t.Fatalf("rss = %v, want 0", st.RSS)
	}
}

func TestHalfOpenCorrection(t *testing.T) {
	ix := NewIndex()
	v1, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 10, Samples: []Sample{{0, 0}, {2, 20}, {3, 30}, {4, 40}, {5, 50}, {9, 90}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	// Correction over [2,5) must remove t=2,3,4 but keep t=5.
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 2, To: 5, Samples: []Sample{{2, 200}, {4, 400}}},
	}}); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Query(2, 0, 9)
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 5 {
		t.Fatalf("count = %d, want 5 (t=5 must survive)", st.Count)
	}
	m := NewModel()
	if _, err := m.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 10, Samples: []Sample{{0, 0}, {2, 200}, {4, 400}, {5, 50}, {9, 90}}},
	}}); err != nil {
		t.Fatal(err)
	}
	want, err := m.Query(1, 0, 9)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Equal(want) {
		t.Fatalf("got %v, want %v", st, want)
	}
	_ = v1
}

func TestHistoricalVersionsUnaffectedByFutureCorrections(t *testing.T) {
	ix := NewIndex()
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 10, Samples: []Sample{{0, 0}, {5, 5}, {9, 9}}},
	}}); err != nil {
		t.Fatal(err)
	}
	before, err := ix.Query(1, 0, 9)
	if err != nil {
		t.Fatal(err)
	}
	// Future corrections that rewrite history.
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 0, To: 10, Samples: []Sample{{0, 100}, {5, -100}, {9, 100}}},
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 2, To: 8, Samples: []Sample{{3, 1}, {7, 2}}},
	}}); err != nil {
		t.Fatal(err)
	}
	after, err := ix.Query(1, 0, 9)
	if err != nil {
		t.Fatal(err)
	}
	if !before.Equal(after) {
		t.Fatalf("historical version changed: before %v, after %v", before, after)
	}
	cur, err := ix.Query(3, 0, 9)
	if err != nil {
		t.Fatal(err)
	}
	if cur.Equal(after) {
		t.Fatalf("current version should differ from historical: %v", cur)
	}
}

func TestCorrectionSampleOutsideRangeRejected(t *testing.T) {
	ix := NewIndex()
	_, err := ix.Commit(Batch{Corrections: []Correction{
		{From: 2, To: 5, Samples: []Sample{{5, 1}}},
	}}) // t=5 is outside half-open [2,5)
	if err == nil {
		t.Fatal("expected error for sample outside half-open range")
	}
}

func TestEmptyRangeAndBadRange(t *testing.T) {
	ix := NewIndex()
	st, err := ix.Query(0, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 0 || st.Slope != nil || st.RSS != nil {
		t.Fatalf("empty: got %v", st)
	}
	if _, err := ix.Query(0, 5, 4); err == nil {
		t.Fatal("expected error for from > to")
	}
	if _, err := ix.Query(7, 0, 1); err == nil {
		t.Fatal("expected error for unknown version")
	}
}
