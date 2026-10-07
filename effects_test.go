package effectcheck

import "testing"

func TestEffectSetOps(t *testing.T) {
	a := NewEffectSet()
	a.AddRead("x")
	a.AddWrite("y")
	a.AddThrow("E")

	b := NewEffectSet()
	if !b.Union(a) {
		t.Error("union into empty set should report change")
	}
	if b.Union(a) {
		t.Error("idempotent union should report no change")
	}
	if !a.Equal(b) {
		t.Error("sets should be equal after union")
	}

	sub := a.Subst(map[string]string{"x": "g"})
	if !sub.Reads["g"] || sub.Reads["x"] {
		t.Errorf("subst reads = %v", sub.Reads)
	}
	if !sub.Writes["y"] {
		t.Errorf("unmapped write should be kept: %v", sub.Writes)
	}
	if !sub.Throws["E"] {
		t.Errorf("throws must not be renamed: %v", sub.Throws)
	}

	sub.Mask(map[string]bool{"g": true})
	if len(sub.Reads) != 0 || !sub.Writes["y"] {
		t.Errorf("mask should drop local reads only: %s", sub)
	}
}
