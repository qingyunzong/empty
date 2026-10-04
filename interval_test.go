package intervalx

import (
	"math/rand"
	"reflect"
	"testing"
)

// brute is a reference model evaluated by scanning every integer
// coordinate in [scanLo, scanHi).
type brute struct {
	ivs []SourcedInterval
}

const (
	scanLo = -14
	scanHi = 14
)

func (b *brute) add(src SourceID, iv Interval) {
	if iv.Lo >= iv.Hi {
		return
	}
	b.ivs = append(b.ivs, SourcedInterval{Source: src, Interval: iv})
}

func (b *brute) deleteSource(src SourceID) {
	kept := b.ivs[:0]
	for _, si := range b.ivs {
		if si.Source != src {
			kept = append(kept, si)
		}
	}
	b.ivs = kept
}

func (b *brute) sumAt(x int) int64 {
	var s int64
	for _, si := range b.ivs {
		if si.Lo <= x && x < si.Hi {
			s += si.Weight
		}
	}
	return s
}

func (b *brute) sourcesAt(x int) []SourceID {
	seen := map[SourceID]bool{}
	var out []SourceID
	for _, si := range b.ivs {
		if si.Lo <= x && x < si.Hi && !seen[si.Source] {
			seen[si.Source] = true
			out = append(out, si.Source)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func (b *brute) segments() []Segment {
	var out []Segment
	for x := scanLo; x < scanHi; x++ {
		if len(b.sourcesAt(x)) == 0 {
			continue
		}
		s := b.sumAt(x)
		if n := len(out); n > 0 && out[n-1].Hi == x && out[n-1].Sum == s {
			out[n-1].Hi = x + 1
			continue
		}
		out = append(out, Segment{Lo: x, Hi: x + 1, Sum: s})
	}
	return out
}

func (b *brute) maxCoverage() (int64, int, bool) {
	segs := b.segments()
	if len(segs) == 0 {
		return 0, 0, false
	}
	max, at := segs[0].Sum, segs[0].Lo
	for _, s := range segs[1:] {
		if s.Sum > max {
			max, at = s.Sum, s.Lo
		}
	}
	return max, at, true
}

func (b *brute) maxSegments() []MaxSegment {
	max, _, ok := b.maxCoverage()
	if !ok {
		return nil
	}
	var out []MaxSegment
	for x := scanLo; x < scanHi; x++ {
		srcs := b.sourcesAt(x)
		if len(srcs) == 0 || b.sumAt(x) != max {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Hi == x && reflect.DeepEqual(out[n-1].Sources, srcs) {
			out[n-1].Hi = x + 1
			continue
		}
		out = append(out, MaxSegment{Lo: x, Hi: x + 1, Sum: max, Sources: srcs})
	}
	return out
}

func checkAgainstBrute(t *testing.T, v *Version, b *brute, ctx string) {
	t.Helper()
	for x := scanLo; x < scanHi; x++ {
		if got, want := v.CoverageSumAt(x), b.sumAt(x); got != want {
			t.Fatalf("%s: CoverageSumAt(%d) = %d, want %d", ctx, x, got, want)
		}
	}
	if got, want := v.Segments(), b.segments(); !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: Segments() = %+v, want %+v", ctx, got, want)
	}
	gotMax, gotAt, gotOK := v.MaxCoverage()
	wantMax, wantAt, wantOK := b.maxCoverage()
	if gotMax != wantMax || gotAt != wantAt || gotOK != wantOK {
		t.Fatalf("%s: MaxCoverage() = (%d,%d,%v), want (%d,%d,%v)",
			ctx, gotMax, gotAt, gotOK, wantMax, wantAt, wantOK)
	}
	if got, want := v.MaxSegments(), b.maxSegments(); !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: MaxSegments() = %+v, want %+v", ctx, got, want)
	}
}

func TestEmptyVersion(t *testing.T) {
	v := New()
	if max, _, ok := v.MaxCoverage(); max != 0 || ok {
		t.Fatalf("empty MaxCoverage = (%d,%v), want (0,false)", max, ok)
	}
	if got := v.Segments(); len(got) != 0 {
		t.Fatalf("empty Segments = %+v", got)
	}
	if got := v.MaxSegments(); got != nil {
		t.Fatalf("empty MaxSegments = %+v", got)
	}
	if got := v.CoverageSumAt(3); got != 0 {
		t.Fatalf("empty CoverageSumAt = %d", got)
	}
}

func TestZeroLengthIgnored(t *testing.T) {
	v := New().
		Add("a", 5, 5, 7).
		Add("a", 3, 2, 4).
		Add("b", 0, 4, 2)
	if got := len(v.Intervals()); got != 1 {
		t.Fatalf("stored intervals = %d, want 1", got)
	}
	checkAgainstBrute(t, v, &brute{ivs: []SourcedInterval{
		{Source: "b", Interval: Interval{Lo: 0, Hi: 4, Weight: 2}},
	}}, "zero-length")
}

func TestDeleteSourceWithdrawsAll(t *testing.T) {
	v := New().
		Add("a", 0, 5, 3).
		Add("a", 2, 8, -1).
		Add("b", 1, 3, 10)
	v = v.DeleteSource("a")
	for _, si := range v.Intervals() {
		if si.Source == "a" {
			t.Fatalf("source a survived DeleteSource: %+v", si)
		}
	}
	b := &brute{}
	b.add("b", Interval{Lo: 1, Hi: 3, Weight: 10})
	checkAgainstBrute(t, v, b, "delete-source")
}

func TestBranchSnapshotsIndependent(t *testing.T) {
	base := New().Add("a", 0, 6, 2)
	branch1 := base.Add("b", 2, 4, 5)
	branch2 := base.DeleteSource("a").Add("c", -3, 1, 1)

	bb := &brute{}
	bb.add("a", Interval{Lo: 0, Hi: 6, Weight: 2})
	checkAgainstBrute(t, base, bb, "base after branching")

	b1 := &brute{}
	b1.add("a", Interval{Lo: 0, Hi: 6, Weight: 2})
	b1.add("b", Interval{Lo: 2, Hi: 4, Weight: 5})
	checkAgainstBrute(t, branch1, b1, "branch1")

	b2 := &brute{}
	b2.add("c", Interval{Lo: -3, Hi: 1, Weight: 1})
	checkAgainstBrute(t, branch2, b2, "branch2")
}

func TestRandomCrossCheck(t *testing.T) {
	sources := []SourceID{"s0", "s1", "s2", "s3"}
	for seed := int64(0); seed < 8; seed++ {
		rng := rand.New(rand.NewSource(seed))
		v := New()
		b := &brute{}
		for step := 0; step < 300; step++ {
			src := sources[rng.Intn(len(sources))]
			if rng.Intn(100) < 65 {
				lo := scanLo + rng.Intn(scanHi-scanLo-1)
				span := scanHi - lo
				if span > 9 {
					span = 9
				}
				hi := lo + rng.Intn(span) // hi == lo gives a zero-length interval
				w := int64(rng.Intn(11) - 5)
				v = v.Add(src, lo, hi, w)
				b.add(src, Interval{Lo: lo, Hi: hi, Weight: w})
			} else {
				v = v.DeleteSource(src)
				b.deleteSource(src)
			}
			checkAgainstBrute(t, v, b, "random")
		}
	}
}

func TestBatchAndInversePatch(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	sources := []SourceID{"s0", "s1", "s2"}
	v0 := New()
	b := &brute{}
	for i := 0; i < 20; i++ {
		src := sources[rng.Intn(len(sources))]
		lo, hi := -6+rng.Intn(10), -6+rng.Intn(10)
		if lo > hi {
			lo, hi = hi, lo
		}
		w := int64(rng.Intn(9) - 4)
		v0 = v0.Add(src, lo, hi, w)
		b.add(src, Interval{Lo: lo, Hi: hi, Weight: w})
	}

	var batch []Op
	for i := 0; i < 30; i++ {
		src := sources[rng.Intn(len(sources))]
		switch rng.Intn(3) {
		case 0:
			lo, hi := -8+rng.Intn(14), -8+rng.Intn(14)
			if lo > hi {
				lo, hi = hi, lo
			}
			iv := Interval{Lo: lo, Hi: hi, Weight: int64(rng.Intn(9) - 4)}
			batch = append(batch, Op{Kind: OpAdd, Source: src, Interval: iv})
		case 1:
			batch = append(batch, Op{Kind: OpDeleteSource, Source: src})
		case 2:
			ivs := v0.Intervals()
			if len(ivs) > 0 {
				victim := ivs[rng.Intn(len(ivs))]
				batch = append(batch, Op{Kind: OpRemove, Source: victim.Source, Interval: victim.Interval})
			}
		}
	}

	v1, patch := v0.Apply(batch)
	// Mirror the batch on the brute model with the same op semantics.
	for _, op := range batch {
		switch op.Kind {
		case OpAdd:
			b.add(op.Source, op.Interval)
		case OpDeleteSource:
			b.deleteSource(op.Source)
		case OpRemove:
			for i, si := range b.ivs {
				if si.Source == op.Source && si.Interval == op.Interval {
					b.ivs = append(b.ivs[:i], b.ivs[i+1:]...)
					break
				}
			}
		}
	}
	checkAgainstBrute(t, v1, b, "batch apply")

	v2 := v1.Revert(patch)
	if !Equal(v0, v2) {
		t.Fatalf("revert mismatch:\n got %v\nwant %v", v2.Intervals(), v0.Intervals())
	}
}

func TestInversePatchRestoresDeletedSource(t *testing.T) {
	v0 := New().
		Add("a", 0, 4, 3).
		Add("a", 2, 6, -2).
		Add("b", 1, 2, 9)
	v1, patch := v0.Apply([]Op{{Kind: OpDeleteSource, Source: "a"}})
	if got := len(v1.Intervals()); got != 1 {
		t.Fatalf("after delete: %d intervals, want 1", got)
	}
	v2 := v1.Revert(patch)
	if !Equal(v0, v2) {
		t.Fatalf("revert of DeleteSource did not restore: %v", v2.Intervals())
	}
}
