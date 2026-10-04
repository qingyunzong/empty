package circcov

import (
	"errors"
	"reflect"
	"testing"
)

func mustAdd(t *testing.T, c *Cover, start, end Angle) int {
	t.Helper()
	id, err := c.Add(start, end)
	if err != nil {
		t.Fatalf("Add(%d, %d): %v", start, end, err)
	}
	return id
}

func TestSplitCrossingZero(t *testing.T) {
	c := New(360)
	mustAdd(t, c, 350, 10) // wraps: covers 350..359 and 0..9
	seg, src, ok := c.MaxCovered(1)
	if !ok {
		t.Fatal("expected a covered segment")
	}
	if seg.Full || seg.Start != 350 || seg.End != 10 {
		t.Fatalf("got %+v, want {Start:350 End:10}", seg)
	}
	if seg.Len(360) != 20 {
		t.Fatalf("len = %d, want 20", seg.Len(360))
	}
	if !reflect.DeepEqual(src, []int{0}) {
		t.Fatalf("sources = %v, want [0]", src)
	}
}

func TestClosedOpenRule(t *testing.T) {
	c := New(4)
	mustAdd(t, c, 0, 1) // covers unit 0 only
	mustAdd(t, c, 1, 3) // covers units 1,2
	// k=2: no unit is covered twice because sectors are half-open.
	if _, _, ok := c.MaxCovered(2); ok {
		t.Fatal("half-open sectors must not overlap at the boundary")
	}
	seg, _, ok := c.MaxCovered(1)
	if !ok || seg.Full || seg.Start != 0 || seg.End != 3 {
		t.Fatalf("got %+v ok=%v, want {Start:0 End:3}", seg, ok)
	}
}

func TestFullCircleSeparateEncoding(t *testing.T) {
	c := New(8)
	if _, err := c.Add(5, 5); !errors.Is(err, ErrDegenerate) {
		t.Fatalf("Add(5,5) err = %v, want ErrDegenerate", err)
	}
	if _, err := c.Add(8, 16); !errors.Is(err, ErrDegenerate) {
		t.Fatalf("Add(8,16) normalizes to degenerate, err = %v", err)
	}
	id := c.AddFull()
	seg, src, ok := c.MaxCovered(1)
	if !ok || !seg.Full {
		t.Fatalf("got %+v ok=%v, want full circle", seg, ok)
	}
	if !reflect.DeepEqual(src, []int{id}) {
		t.Fatalf("sources = %v, want [%d]", src, id)
	}
	if c.Size() != 1 {
		t.Fatalf("size = %d, want 1", c.Size())
	}
}

func TestAddNormalizesAngles(t *testing.T) {
	c := New(12)
	mustAdd(t, c, -2, 14) // == [10, 2) crossing zero
	seg, _, ok := c.MaxCovered(1)
	if !ok || seg.Full || seg.Start != 10 || seg.End != 2 {
		t.Fatalf("got %+v ok=%v, want {Start:10 End:2}", seg, ok)
	}
}

func TestRemove(t *testing.T) {
	c := New(10)
	a := mustAdd(t, c, 0, 5)
	b := c.AddFull()
	if !c.Remove(a) {
		t.Fatal("Remove(a) = false, want true")
	}
	if c.Remove(a) {
		t.Fatal("second Remove(a) = true, want false")
	}
	if c.Remove(999) {
		t.Fatal("Remove(unknown) = true, want false")
	}
	seg, src, ok := c.MaxCovered(1)
	if !ok || !seg.Full || !reflect.DeepEqual(src, []int{b}) {
		t.Fatalf("got %+v src=%v ok=%v", seg, src, ok)
	}
	if _, _, ok := c.MaxCovered(2); ok {
		t.Fatal("k=2 must fail after removing the partial sector")
	}
}

func TestMaxSegmentWrapsZero(t *testing.T) {
	c := New(360)
	mustAdd(t, c, 10, 40)
	mustAdd(t, c, 300, 350)
	mustAdd(t, c, 340, 20) // joins 300..350 with 10..40 across zero
	seg, _, ok := c.MaxCovered(1)
	if !ok || seg.Full || seg.Start != 300 || seg.End != 40 {
		t.Fatalf("got %+v ok=%v, want {Start:300 End:40}", seg, ok)
	}
	if seg.Len(360) != 100 {
		t.Fatalf("len = %d, want 100", seg.Len(360))
	}
}

func TestSourceSet(t *testing.T) {
	c := New(100)
	a := mustAdd(t, c, 10, 60)
	b := mustAdd(t, c, 20, 50) // inside a
	d := mustAdd(t, c, 55, 90) // touches b's end, half-open: no k=2 past 50
	seg, src, ok := c.MaxCovered(2)
	if !ok || seg.Start != 20 || seg.End != 50 {
		t.Fatalf("got %+v ok=%v, want {Start:20 End:50}", seg, ok)
	}
	if !reflect.DeepEqual(src, []int{a, b}) {
		t.Fatalf("sources = %v, want [%d %d]", src, a, b)
	}
	_ = d
}

func TestTieBreakSmallestStart(t *testing.T) {
	c := New(100)
	mustAdd(t, c, 50, 60)
	mustAdd(t, c, 10, 20)
	seg, _, ok := c.MaxCovered(1)
	if !ok || seg.Start != 10 || seg.End != 20 {
		t.Fatalf("got %+v ok=%v, want the segment starting at 10", seg, ok)
	}
}

func TestNoCoverage(t *testing.T) {
	c := New(6)
	if _, _, ok := c.MaxCovered(1); ok {
		t.Fatal("empty cover must report ok=false")
	}
	mustAdd(t, c, 0, 3)
	if _, _, ok := c.MaxCovered(2); ok {
		t.Fatal("k=2 above max coverage must report ok=false")
	}
}

func TestKNonPositive(t *testing.T) {
	c := New(6)
	seg, src, ok := c.MaxCovered(0)
	if !ok || !seg.Full || len(src) != 0 {
		t.Fatalf("got %+v src=%v ok=%v, want full circle, no sources", seg, src, ok)
	}
}

func TestFullPlusPartialSources(t *testing.T) {
	c := New(10)
	f := c.AddFull()
	p := mustAdd(t, c, 2, 5)
	// k=2 is only reachable inside [2,5); the full sector is a source
	// everywhere, the partial one only on its own arc.
	seg, src, ok := c.MaxCovered(2)
	if !ok || seg.Start != 2 || seg.End != 5 {
		t.Fatalf("got %+v ok=%v, want {Start:2 End:5}", seg, ok)
	}
	if !reflect.DeepEqual(src, []int{f, p}) {
		t.Fatalf("sources = %v, want [%d %d]", src, f, p)
	}
}
