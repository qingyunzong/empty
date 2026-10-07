package imgdiff

import (
	"encoding/json"
	"testing"
)

func TestImageJSONRoundTrip(t *testing.T) {
	img := specImage("A-B", map[int]bool{2: true})
	b, err := json.Marshal(img.ToJSON())
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseImageJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	cd, err := ContentDiff(img, got)
	if err != nil {
		t.Fatal(err)
	}
	ld, err := LayoutDiff(img, got)
	if err != nil {
		t.Fatal(err)
	}
	if len(cd) != 0 || len(ld) != 0 {
		t.Fatalf("round trip changed image: content %v layout %v", cd, ld)
	}
	if !got.Extents[2].Shared {
		t.Fatal("shared flag lost in round trip")
	}
}

func TestPlanJSONRoundTrip(t *testing.T) {
	old := specImage("AB", map[int]bool{1: true})
	newImg := specImage("BA", nil)
	p, err := BuildPlan(old, newImg, testBlock)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(p.ToJSON())
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParsePlanJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Steps) != len(p.Steps) {
		t.Fatalf("step count %d, want %d", len(got.Steps), len(p.Steps))
	}
	if err := VerifyPlan(old, newImg, got); err != nil {
		t.Fatalf("parsed plan fails verification: %v", err)
	}
}

func TestMachineStateRoundTrip(t *testing.T) {
	old := specImage("ABCD", map[int]bool{2: true})
	newImg := specImage("DABC", nil)
	p, err := BuildPlan(old, newImg, testBlock)
	if err != nil {
		t.Fatal(err)
	}
	// Execute half the plan, snapshot, restore, finish.
	m, err := NewMachine(old, testBlock)
	if err != nil {
		t.Fatal(err)
	}
	before := m.ParentSnapshot()
	half := len(p.Steps) / 2
	for i := 0; i < half; i++ {
		if err := m.Step(p); err != nil {
			t.Fatal(err)
		}
	}
	b, err := json.Marshal(m.MarshalState())
	if err != nil {
		t.Fatal(err)
	}
	var st MachineJSON
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	m2, err := MachineFromState(&st)
	if err != nil {
		t.Fatal(err)
	}
	if err := m2.Run(p); err != nil {
		t.Fatal(err)
	}
	if err := m2.Verify(newImg, before); err != nil {
		t.Fatalf("resumed machine fails verification: %v", err)
	}
}

func TestParseImageJSONRejectsBadInput(t *testing.T) {
	if _, err := ParseImageJSON([]byte(`{"size":4,"extents":[{"start":0,"len":2,"kind":"data","data":"!!"}]}`)); err == nil {
		t.Fatal("bad base64 accepted")
	}
	if _, err := ParseImageJSON([]byte(`{"size":4,"extents":[{"start":0,"len":2,"kind":"flurb"}]}`)); err == nil {
		t.Fatal("bad kind accepted")
	}
	// Out-of-range interval in the wire format must be rejected.
	if _, err := ParseImageJSON([]byte(`{"size":4,"extents":[{"start":2,"len":4,"kind":"hole"}]}`)); err == nil {
		t.Fatal("out-of-range extent accepted")
	}
}
