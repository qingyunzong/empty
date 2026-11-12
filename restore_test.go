package dataeng

import (
	"reflect"
	"testing"
)

func u32(v uint32) *uint32 { return &v }

func snapshotCells(cells []Cell) []Cell {
	clone := make([]Cell, len(cells))
	copy(clone, cells)
	for i := range clone {
		if cells[i].Formula != nil {
			f := *cells[i].Formula
			clone[i].Formula = &f
			if cells[i].Formula.SI != nil {
				v := *cells[i].Formula.SI
				clone[i].Formula.SI = &v
			}
		}
	}
	return clone
}

func findRestored(t *testing.T, got []RestoredFormula, coord string) RestoredFormula {
	t.Helper()
	for _, item := range got {
		if item.Coord == coord {
			return item
		}
	}
	t.Fatalf("restored formula for %q not found", coord)
	return RestoredFormula{}
}

func TestRestoreSlaveFirstAndNormalCellOverride(t *testing.T) {
	cells := []Cell{
		{Coord: "C3", Formula: &Formula{Type: "shared", SI: u32(7)}},
		{Coord: "B2", Formula: &Formula{Type: "shared", SI: u32(7), Ref: "B2:D4",
			Text: "SUM($A$1,B2,Sheet2!C3:D4)+\"B2\""}},
		{Coord: "C2", Formula: &Formula{Text: "C2_OWN"}},
		{Coord: "D4", Formula: &Formula{Type: "shared", SI: u32(7), Text: "IGNORED"}},
	}
	before := snapshotCells(cells)

	got, err := Restore(cells)
	if err != nil {
		t.Fatalf("Restore unexpected error: %v", err)
	}
	if !reflect.DeepEqual(cells, before) {
		t.Fatalf("Restore changed input snapshot:\nbefore=%#v\nafter =%#v", before, cells)
	}

	wantOrder := []string{"B2", "C2", "C3", "D4"}
	if len(got) != len(wantOrder) {
		t.Fatalf("got %d results, want %d", len(got), len(wantOrder))
	}
	for i, coord := range wantOrder {
		if got[i].Coord != coord {
			t.Fatalf("result[%d] = %q, want %q (full order %v)", i, got[i].Coord, coord, coords(got))
		}
	}

	master := findRestored(t, got, "B2")
	if !master.Master || master.MasterSI != 7 || master.Text != "SUM($A$1,B2,Sheet2!C3:D4)+\"B2\"" {
		t.Fatalf("master restored incorrectly: %#v", master)
	}
	if len(master.Changes) != 0 {
		t.Fatalf("master must not report changes, got %#v", master.Changes)
	}

	normal := findRestored(t, got, "C2")
	if normal.Master || normal.Text != "C2_OWN" || normal.MasterSI != 0 {
		t.Fatalf("normal cell inside shared rectangle must keep its formula: %#v", normal)
	}

	slave := findRestored(t, got, "C3")
	wantText := "SUM($A$1,C3,Sheet2!D4:E5)+\"B2\""
	if slave.Master || slave.MasterSI != 7 || slave.Text != wantText {
		t.Fatalf("slave = %#v, want text %q", slave, wantText)
	}
	if len(slave.Changes) != 3 {
		t.Fatalf("slave changes = %#v, want three reference changes (absolute one unchanged but recorded)", slave.Changes)
	}
	if slave.Changes[0].Original != "$A$1" || slave.Changes[0].Replaced != "$A$1" {
		t.Fatalf("first change wrong: %#v", slave.Changes[0])
	}
	if slave.Changes[1].Original != "B2" || slave.Changes[1].Replaced != "C3" {
		t.Fatalf("relative change wrong: %#v", slave.Changes[1])
	}
	if slave.Changes[2].Original != "Sheet2!C3:D4" ||
		slave.Changes[2].Prefix != "Sheet2!" ||
		slave.Changes[2].Replaced != "D4:E5" {
		t.Fatalf("prefixed range change wrong: %#v", slave.Changes[2])
	}

	corner := findRestored(t, got, "D4")
	if corner.Text != "SUM($A$1,D4,Sheet2!E5:F6)+\"B2\"" || corner.Master {
		t.Fatalf("corner slave wrong: %#v", corner)
	}
}

func coords(items []RestoredFormula) []string {
	out := make([]string, len(items))
	for i := range items {
		out[i] = items[i].Coord
	}
	return out
}

func TestRestoreNegativeDeltaRefErrorIntervals(t *testing.T) {
	cells := []Cell{
		{Coord: "B2", Formula: &Formula{Type: "shared", SI: u32(1), Ref: "A2:B2", Text: "A1+A1:B2"}},
		{Coord: "A2", Formula: &Formula{Type: "shared", SI: u32(1)}},
	}
	got, err := Restore(cells)
	if err != nil {
		t.Fatalf("Restore unexpected error: %v", err)
	}
	slave := findRestored(t, got, "A2")
	if slave.Text != "#REF!+#REF!" {
		t.Fatalf("slave text = %q, want #REF!+#REF!", slave.Text)
	}
	if len(slave.Changes) != 2 || !slave.Changes[0].RefError || !slave.Changes[1].RefError {
		t.Fatalf("expected two ref-error changes, got %#v", slave.Changes)
	}
	if slave.Changes[0].Original != "A1" || slave.Changes[1].Original != "A1:B2" {
		t.Fatalf("wrong original intervals: %#v", slave.Changes)
	}
}

func TestRestoreRejectsInvalidSheets(t *testing.T) {
	cases := []struct {
		name  string
		cells []Cell
	}{
		{
			name: "unknown formula type",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "array", Text: "1"}},
			},
		},
		{
			name: "lowercase coordinate",
			cells: []Cell{
				{Coord: "a1", Formula: &Formula{Text: "1"}},
			},
		},
		{
			name: "leading zero row",
			cells: []Cell{
				{Coord: "A01", Formula: &Formula{Text: "1"}},
			},
		},
		{
			name: "duplicate cell",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Text: "1"}},
				{Coord: "A1", Formula: &Formula{Text: "2"}},
			},
		},
		{
			name: "normal missing text",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "normal"}},
			},
		},
		{
			name: "shared missing si",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "shared", Ref: "A1", Text: "1"}},
			},
		},
		{
			name: "duplicate master si",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "shared", SI: u32(3), Ref: "A1", Text: "1"}},
				{Coord: "B1", Formula: &Formula{Type: "shared", SI: u32(3), Ref: "B1", Text: "2"}},
			},
		},
		{
			name: "slave missing master",
			cells: []Cell{
				{Coord: "B2", Formula: &Formula{Type: "shared", SI: u32(9)}},
			},
		},
		{
			name: "slave outside ref",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "shared", SI: u32(4), Ref: "A1:A2", Text: "1"}},
				{Coord: "B2", Formula: &Formula{Type: "shared", SI: u32(4)}},
			},
		},
		{
			name: "master outside own ref",
			cells: []Cell{
				{Coord: "C1", Formula: &Formula{Type: "shared", SI: u32(4), Ref: "A1:B2", Text: "1"}},
			},
		},
		{
			name: "overlapping master rectangles",
			cells: []Cell{
				{Coord: "B2", Formula: &Formula{Type: "shared", SI: u32(1), Ref: "B2:C3", Text: "1"}},
				{Coord: "C3", Formula: &Formula{Type: "shared", SI: u32(2), Ref: "C3:D4", Text: "2"}},
			},
		},
		{
			name: "non shared carries si",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Text: "1", SI: u32(1)}},
			},
		},
		{
			name: "non shared carries ref",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Text: "1", Ref: "A1"}},
			},
		},
		{
			name: "master has empty text",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "shared", SI: u32(1), Ref: "A1"}},
			},
		},
		{
			name: "bad master ref",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "shared", SI: u32(1), Ref: "a1", Text: "1"}},
			},
		},
		{
			name: "out of range master ref",
			cells: []Cell{
				{Coord: "A1", Formula: &Formula{Type: "shared", SI: u32(1), Ref: "A1:XFE1", Text: "1"}},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Restore(tc.cells); err == nil {
				t.Fatalf("Restore(%s) expected error", tc.name)
			}
		})
	}
}

func TestRestorePlainValueCellsAreIgnored(t *testing.T) {
	cells := []Cell{
		{Coord: "A9", Formula: nil},
		{Coord: "A1", Formula: &Formula{Text: "1+2"}},
	}
	got, err := Restore(cells)
	if err != nil {
		t.Fatalf("Restore unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Coord != "A1" {
		t.Fatalf("plain value cell must be omitted, got %#v", got)
	}
}
