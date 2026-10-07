package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cutcli/cutting"
)

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCLIEndToEnd(t *testing.T) {
	dir := t.TempDir()
	spec1 := filepath.Join(dir, "order1.json")
	invPath := filepath.Join(dir, "inv.json")
	plan1Path := filepath.Join(dir, "plan1.json")

	// Order 1: cut 12 from a 20-bar, remnant 8 goes to inventory.
	writeJSON(t, spec1, cutting.Spec{
		Kerf: 0, MinRemnant: 5, CutCost: 1,
		StockTypes: []cutting.StockType{{Length: 20, Cost: 30}},
		Demands:    []cutting.Demand{{Length: 12, Count: 1}},
	})
	var out bytes.Buffer
	if code := run([]string{"-spec", spec1, "-inv", invPath, "-out", plan1Path, "-verify"}, &out); code != 0 {
		t.Fatalf("order 1 exit %d:\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "verify: exhaustive enumeration confirms optimum") {
		t.Errorf("missing verify confirmation:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "conservation: stock 20 = demand 12 + kerf 0 + remnant 8 + scrap 0 (ok=true)") {
		t.Errorf("missing conservation line:\n%s", out.String())
	}
	var inv cutting.Inventory
	data, err := os.ReadFile(invPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &inv); err != nil {
		t.Fatal(err)
	}
	if len(inv.Remnants) != 1 || inv.Remnants[0].ID != "R0001" || inv.Remnants[0].Length != 8 {
		t.Fatalf("inventory remnants = %+v, want R0001 len 8", inv.Remnants)
	}

	// Order 2: demand 8 is satisfied by remnant R0001 at zero purchase cost.
	spec2 := filepath.Join(dir, "order2.json")
	writeJSON(t, spec2, cutting.Spec{
		Kerf: 0, MinRemnant: 5, CutCost: 1,
		StockTypes: []cutting.StockType{{Length: 20, Cost: 30}},
		Demands:    []cutting.Demand{{Length: 8, Count: 1}},
	})
	out.Reset()
	if code := run([]string{"-spec", spec2, "-inv", invPath}, &out); code != 0 {
		t.Fatalf("order 2 exit %d:\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "purchase=0") {
		t.Errorf("order 2 should reuse remnant for free:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "R0001") {
		t.Errorf("order 2 should reference stable remnant ID R0001:\n%s", out.String())
	}

	// Demand correction: previous plan cut one 12; new demand is 12+8.
	// Remaining demand (one 8) is planned against the inventory.
	spec3 := filepath.Join(dir, "order3.json")
	writeJSON(t, spec3, cutting.Spec{
		Kerf: 0, MinRemnant: 5, CutCost: 1,
		StockTypes: []cutting.StockType{{Length: 20, Cost: 30}},
		Demands:    []cutting.Demand{{Length: 12, Count: 1}, {Length: 8, Count: 1}},
	})
	out.Reset()
	if code := run([]string{"-spec", spec3, "-inv", invPath, "-prev", plan1Path}, &out); code != 0 {
		t.Fatalf("correction exit %d:\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "remaining demand [{Length:8 Count:1}]") {
		t.Errorf("correction should plan only the additional 8:\n%s", out.String())
	}
}

func TestCLICorrectionNothingToDo(t *testing.T) {
	dir := t.TempDir()
	prevPath := filepath.Join(dir, "prev.json")
	writeJSON(t, prevPath, cutting.Plan{Bars: []cutting.BarPlan{{Pieces: []cutting.PlacedPiece{
		{ID: "P1", Length: 5}, {ID: "P2", Length: 5},
	}}}})
	specPath := filepath.Join(dir, "spec.json")
	writeJSON(t, specPath, cutting.Spec{
		StockTypes: []cutting.StockType{{Length: 10, Cost: 5}},
		Demands:    []cutting.Demand{{Length: 5, Count: 1}},
	})
	var out bytes.Buffer
	if code := run([]string{"-spec", specPath, "-prev", prevPath}, &out); code != 0 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "no additional purchase needed") {
		t.Errorf("want nothing-to-do message:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "surplus") {
		t.Errorf("want surplus report:\n%s", out.String())
	}
}
