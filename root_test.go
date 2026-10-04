package intervalx

import (
	"testing"
)

type crashInjector struct {
	point string
	armed bool
	fired bool
}

func (c *crashInjector) Hook(p string) {
	if c.armed && p == c.point && !c.fired {
		c.fired = true
		panic(ErrCrash)
	}
}

func tryPublish(r *Root, v *Version) (crashed bool) {
	defer func() {
		if rec := recover(); rec != nil {
			if rec != ErrCrash {
				panic(rec)
			}
			crashed = true
		}
	}()
	if err := r.Publish(v); err != nil {
		panic(err)
	}
	return false
}

func assertConsistent(t *testing.T, got *Version, old, new *Version, ctx string) {
	t.Helper()
	switch {
	case Equal(got, old) && got.Epoch() == old.Epoch():
	case Equal(got, new) && got.Epoch() == new.Epoch():
	default:
		t.Fatalf("%s: recovered version mixes trees or is corrupt (epoch %d, intervals %v)",
			ctx, got.Epoch(), got.Intervals())
	}
}

func TestPublishRecoverAllFaultPoints(t *testing.T) {
	points := []string{"invalidate", "midData", "data", "meta", "commit", ""}
	for _, point := range points {
		inj := &crashInjector{point: point}
		r := NewRoot(inj)

		v1 := New().Add("a", 0, 5, 3).Add("b", 2, 7, -1)
		if tryPublish(r, v1) {
			t.Fatalf("point %q: first publish crashed", point)
		}
		assertConsistent(t, r.Recover(), New(), v1, "point "+point+" first recover")

		inj.armed = true
		v2 := v1.DeleteSource("a").Add("c", -4, 1, 8)
		tryPublish(r, v2)
		got := r.Recover()
		assertConsistent(t, got, v1, v2, "point "+point)

		if point == "commit" || point == "" {
			if !Equal(got, v2) {
				t.Fatalf("point %q: expected new tree after commit", point)
			}
		} else if !Equal(got, v1) {
			t.Fatalf("point %q: expected old tree before commit", point)
		}
	}
}

func TestRecoverEmptyRoot(t *testing.T) {
	r := NewRoot(nil)
	got := r.Recover()
	if max, _, ok := got.MaxCoverage(); max != 0 || ok {
		t.Fatalf("empty root MaxCoverage = (%d,%v), want (0,false)", max, ok)
	}
}

func TestPublishAlternatesSlots(t *testing.T) {
	r := NewRoot(nil)
	v1 := New().Add("a", 0, 3, 1)
	v2 := v1.Add("b", 1, 2, 4)
	v3 := v2.DeleteSource("a")
	for i, v := range []*Version{v1, v2, v3} {
		if err := r.Publish(v); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
		got := r.Recover()
		if !Equal(got, v) || got.Epoch() != v.Epoch() {
			t.Fatalf("publish %d: recovered %v (epoch %d), want epoch %d",
				i, got.Intervals(), got.Epoch(), v.Epoch())
		}
	}
}

// TestRecoveryAfterCorruption verifies a torn slot image is never served.
func TestRecoveryAfterCorruption(t *testing.T) {
	r := NewRoot(nil)
	v1 := New().Add("a", 0, 3, 1)
	v2 := v1.Add("b", 5, 9, 2)
	if err := r.Publish(v1); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(v2); err != nil {
		t.Fatal(err)
	}
	// Corrupt the active slot's payload directly.
	r.slots[r.active].data = r.slots[r.active].data[:3]
	got := r.Recover()
	if !Equal(got, v1) {
		t.Fatalf("corrupt active slot: recovered %v, want previous tree %v",
			got.Intervals(), v1.Intervals())
	}
}
