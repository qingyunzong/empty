package sigdb

import (
	"math/big"
	"math/rand"
	"sort"
	"testing"
)

// refModel is the independent per-segment integration model the store is
// checked against. It resolves versions with the same rules but computes
// integrals by brute force over consecutive present samples.
type refModel struct {
	entries map[int64]entry
}

func newRefModel() *refModel { return &refModel{entries: make(map[int64]entry)} }

func (m *refModel) clone() *refModel {
	c := &refModel{entries: make(map[int64]entry, len(m.entries))}
	for k, v := range m.entries {
		c.entries[k] = v
	}
	return c
}

func (m *refModel) apply(ops []Op) {
	for _, op := range ops {
		e, ok := m.entries[op.T]
		if ok && op.Version <= e.version {
			continue
		}
		ne := entry{t: op.T, version: op.Version, kind: op.Kind}
		if op.Kind == KindPresent {
			ne.v = new(big.Rat).Set(op.V)
		}
		m.entries[op.T] = ne
	}
}

func (m *refModel) sorted() []entry {
	out := make([]entry, 0, len(m.entries))
	for _, e := range m.entries {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].t < out[j].t })
	return out
}

// integral integrates the piecewise-linear signal segment by segment,
// never interpolating across missing values or tombstones.
func (m *refModel) integral(a, b int64) *big.Rat {
	acc := new(big.Rat)
	es := m.sorted()
	for i := 0; i+1 < len(es); i++ {
		x, y := es[i], es[i+1]
		if x.kind != KindPresent || y.kind != KindPresent {
			continue
		}
		acc.Add(acc, segIntegral(x.t, x.v, y.t, y.v, a, b))
	}
	return acc
}

func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("bad rat " + s)
	}
	return r
}

func checkSamples(t *testing.T, sn *Snapshot, m *refModel) {
	t.Helper()
	got := sn.Samples()
	want := m.sorted()
	if len(got) != len(want) {
		t.Fatalf("sample count: got %d want %d", len(got), len(want))
	}
	for i, w := range want {
		g := got[i]
		if g.T != w.t || g.Kind != w.kind || g.Version != w.version {
			t.Fatalf("sample %d: got %+v want %+v", i, g, w)
		}
		if (g.V == nil) != (w.v == nil) || (g.V != nil && g.V.Cmp(w.v) != 0) {
			t.Fatalf("sample %d value: got %v want %v", i, g.V, w.v)
		}
	}
}

func TestBasicIntegral(t *testing.T) {
	s, err := openStore(newMemFile(), newMemFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply([]Op{toPut(0, 1, rat("0")), toPut(10, 1, rat("10"))}); err != nil {
		t.Fatal(err)
	}
	head := s.Head()
	for _, tc := range []struct {
		a, b int64
		want string
	}{
		{0, 10, "50"},
		{0, 5, "25/2"},
		{-5, 20, "50"},
		{3, 7, "20"},
		{10, 10, "0"},
		{8, 2, "0"},
	} {
		if got := head.Integral(tc.a, tc.b); got.Cmp(rat(tc.want)) != 0 {
			t.Errorf("Integral(%d,%d) = %s, want %s", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestMissingCutsSignal(t *testing.T) {
	s, err := openStore(newMemFile(), newMemFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply([]Op{
		toPut(0, 1, rat("0")), toPut(5, 1, rat("100")), toPut(10, 1, rat("0")),
	}); err != nil {
		t.Fatal(err)
	}
	if got := s.Head().Integral(0, 10); got.Cmp(rat("500")) != 0 {
		t.Fatalf("got %s want 500", got)
	}
	// Mark the middle sample missing: both adjacent segments vanish.
	if _, _, err := s.Apply([]Op{Missing(5, 2)}); err != nil {
		t.Fatal(err)
	}
	if got := s.Head().Integral(0, 10); got.Sign() != 0 {
		t.Fatalf("missing value must cut interval, got %s", got)
	}
	// Deleting the marker leaves a tombstone, which still cuts.
	if _, _, err := s.Apply([]Op{Delete(5, 3)}); err != nil {
		t.Fatal(err)
	}
	if got := s.Head().Integral(0, 10); got.Sign() != 0 {
		t.Fatalf("tombstone must cut interval, got %s", got)
	}
	// Re-putting with a higher version restores interpolation.
	if _, _, err := s.Apply([]Op{toPut(5, 4, rat("100"))}); err != nil {
		t.Fatal(err)
	}
	if got := s.Head().Integral(0, 10); got.Cmp(rat("500")) != 0 {
		t.Fatalf("got %s want 500", got)
	}
}

func TestVersionOverwrite(t *testing.T) {
	s, err := openStore(newMemFile(), newMemFile())
	if err != nil {
		t.Fatal(err)
	}
	must := func(ops []Op) {
		t.Helper()
		if _, _, err := s.Apply(ops); err != nil {
			t.Fatal(err)
		}
	}
	must([]Op{toPut(0, 1, rat("0")), toPut(10, 1, rat("0"))})
	must([]Op{toPut(5, 5, rat("10"))})
	if got := s.Head().Integral(0, 10); got.Cmp(rat("50")) != 0 {
		t.Fatalf("got %s want 50", got)
	}
	// Lower and equal versions lose.
	must([]Op{toPut(5, 4, rat("1000")), toPut(5, 5, rat("1000"))})
	if got := s.Head().Integral(0, 10); got.Cmp(rat("50")) != 0 {
		t.Fatalf("stale version must be rejected, got %s", got)
	}
	// Higher version wins.
	must([]Op{toPut(5, 6, rat("20"))})
	if got := s.Head().Integral(0, 10); got.Cmp(rat("100")) != 0 {
		t.Fatalf("got %s want 100", got)
	}
	// A delete loses to a higher-version put that arrived earlier.
	must([]Op{Delete(5, 6)})
	if got := s.Head().Integral(0, 10); got.Cmp(rat("100")) != 0 {
		t.Fatalf("equal-version delete must lose, got %s", got)
	}
	must([]Op{Delete(5, 7)})
	if got := s.Head().Integral(0, 10); got.Sign() != 0 {
		t.Fatalf("delete must win, got %s", got)
	}
	// An even older put is still rejected after the tombstone.
	must([]Op{toPut(5, 6, rat("50"))})
	if got := s.Head().Integral(0, 10); got.Sign() != 0 {
		t.Fatalf("stale put must lose to tombstone, got %s", got)
	}
}

func TestLocalInverseDelta(t *testing.T) {
	s, err := openStore(newMemFile(), newMemFile())
	if err != nil {
		t.Fatal(err)
	}
	ops := []Op{toPut(0, 1, rat("1")), toPut(10, 1, rat("3")), toPut(20, 1, rat("5")), toPut(30, 1, rat("7"))}
	if _, _, err := s.Apply(ops); err != nil {
		t.Fatal(err)
	}
	before := s.Head().Integral(-100, 100)
	// Correct one sample; only adjacent segments may appear in the delta.
	snap, d, err := s.Apply([]Op{toPut(10, 2, rat("13"))})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Removed) != 2 || len(d.Added) != 2 {
		t.Fatalf("local correction should touch 2 segments, got -%d +%d", len(d.Removed), len(d.Added))
	}
	net := new(big.Rat)
	for _, seg := range d.Added {
		net.Add(net, seg.integral())
	}
	for _, seg := range d.Removed {
		net.Sub(net, seg.integral())
	}
	got := snap.Integral(-100, 100)
	want := new(big.Rat).Add(before, net)
	if got.Cmp(want) != 0 {
		t.Fatalf("inverse difference mismatch: got %s want %s", got, want)
	}
}

func TestRandomizedDifferential(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	s, err := openStore(newMemFile(), newMemFile())
	if err != nil {
		t.Fatal(err)
	}
	m := newRefModel()
	type checkpoint struct {
		snap *Snapshot
		m    *refModel
	}
	var history []checkpoint
	for batch := 0; batch < 60; batch++ {
		n := 1 + rng.Intn(6)
		ops := make([]Op, 0, n)
		for i := 0; i < n; i++ {
			ts := int64(rng.Intn(120))
			ver := uint64(rng.Intn(8))
			switch rng.Intn(3) {
			case 0:
				ops = append(ops, toPut(ts, ver, big.NewRat(int64(rng.Intn(41)-20), int64(1+rng.Intn(4)))))
			case 1:
				ops = append(ops, Missing(ts, ver))
			default:
				ops = append(ops, Delete(ts, ver))
			}
		}
		snap, _, err := s.Apply(ops)
		if err != nil {
			t.Fatal(err)
		}
		m.apply(ops)
		checkSamples(t, snap, m)
		for q := 0; q < 10; q++ {
			a := int64(rng.Intn(140) - 10)
			b := int64(rng.Intn(140) - 10)
			if a > b {
				a, b = b, a
			}
			if got, want := snap.Integral(a, b), m.integral(a, b); got.Cmp(want) != 0 {
				t.Fatalf("batch %d Integral(%d,%d): got %s want %s", batch, a, b, got, want)
			}
		}
		history = append(history, checkpoint{snap, m.clone()})
	}
	// Old readers: every historical snapshot must still answer correctly.
	for i, cp := range history {
		for q := 0; q < 4; q++ {
			a := int64(rng.Intn(140) - 10)
			b := int64(rng.Intn(140) - 10)
			if a > b {
				a, b = b, a
			}
			if got, want := cp.snap.Integral(a, b), cp.m.integral(a, b); got.Cmp(want) != 0 {
				t.Fatalf("snapshot %d Integral(%d,%d): got %s want %s", i, a, b, got, want)
			}
		}
	}
}

func TestPersistenceReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := newRefModel()
	rng := rand.New(rand.NewSource(7))
	applyBatch := func(st *Store) {
		ops := make([]Op, 0, 5)
		for i := 0; i < 5; i++ {
			ts := int64(rng.Intn(60))
			ver := uint64(rng.Intn(30))
			if rng.Intn(4) == 0 {
				ops = append(ops, Delete(ts, ver))
			} else {
				ops = append(ops, toPut(ts, ver, big.NewRat(int64(rng.Intn(21)-10), int64(1+rng.Intn(3)))))
			}
		}
		if _, _, err := st.Apply(ops); err != nil {
			t.Fatal(err)
		}
		m.apply(ops)
	}
	for i := 0; i < 8; i++ {
		applyBatch(s)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	checkSamples(t, s2.Head(), m)
	for q := 0; q < 20; q++ {
		a := int64(rng.Intn(80) - 10)
		b := int64(rng.Intn(80) - 10)
		if a > b {
			a, b = b, a
		}
		if got, want := s2.Head().Integral(a, b), m.integral(a, b); got.Cmp(want) != 0 {
			t.Fatalf("after reopen Integral(%d,%d): got %s want %s", a, b, got, want)
		}
	}
	// The store keeps working after recovery.
	for i := 0; i < 4; i++ {
		applyBatch(s2)
	}
	checkSamples(t, s2.Head(), m)
	for q := 0; q < 20; q++ {
		a := int64(rng.Intn(80) - 10)
		b := int64(rng.Intn(80) - 10)
		if a > b {
			a, b = b, a
		}
		if got, want := s2.Head().Integral(a, b), m.integral(a, b); got.Cmp(want) != 0 {
			t.Fatalf("post-recovery Integral(%d,%d): got %s want %s", a, b, got, want)
		}
	}
	if err := s2.Close(); err != nil {
		t.Fatal(err)
	}
}
