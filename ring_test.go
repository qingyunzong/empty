package formal

import (
	"errors"
	"testing"
)

func TestRingMinimalDisruption(t *testing.T) {
	base := []Backend{
		{ID: "a", Weight: 1},
		{ID: "b", Weight: 2},
		{ID: "c", Weight: 3},
	}
	before := buildRing(base, 1024)
	withoutB := buildRing([]Backend{base[0], base[2]}, 1024)
	withD := buildRing(append(append([]Backend(nil), base...), Backend{ID: "d", Weight: 2}), 1024)

	const n = 50000
	movedOnRemove := 0
	movedOnAdd := 0
	for i := 0; i < n; i++ {
		h := hashTuple(flowKey(i))
		oldID, _ := before.pick(h)
		newID, _ := withoutB.pick(h)
		if oldID != newID {
			if oldID != "b" {
				t.Fatalf("removing b moved unrelated key %d: %s -> %s", i, oldID, newID)
			}
			movedOnRemove++
		}
		addID, _ := withD.pick(h)
		if addID != oldID {
			if addID != "d" {
				t.Fatalf("adding d moved key %d to non-new backend: %s -> %s", i, oldID, addID)
			}
			movedOnAdd++
		}
	}
	if movedOnRemove == 0 || movedOnAdd == 0 {
		t.Fatalf("expected movement, got remove=%d add=%d", movedOnRemove, movedOnAdd)
	}
}

func TestRingEmpty(t *testing.T) {
	r := buildRing(nil, 1024)
	if _, ok := r.pick(123); ok {
		t.Fatal("empty ring returned a backend")
	}
	var nilRing *hashRing
	if _, ok := nilRing.pick(123); ok {
		t.Fatal("nil ring returned a backend")
	}
}

func TestErrorsAreDistinct(t *testing.T) {
	all := []error{
		ErrInvalidKey, ErrInvalidBackend, ErrNoBackends, ErrFlowActive,
		ErrFlowClosed, ErrUnknownFlow, ErrStaleGeneration, ErrUnknownBackend,
	}
	for i, a := range all {
		for j, b := range all {
			if i != j && errors.Is(a, b) {
				t.Fatalf("error %v matches %v", a, b)
			}
		}
	}
}
