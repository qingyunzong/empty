package pivot_test

import (
	"errors"
	"reflect"
	"testing"

	"example.org/dataeng/q0165/pivot"
)

func strptr(s string) *string { return &s }

func mustApply(t *testing.T, tb *pivot.Table, ops ...pivot.Op) pivot.SchemaChange {
	t.Helper()
	sc, err := tb.Apply(ops)
	if err != nil {
		t.Fatalf("Apply failed: %v", err)
	}
	return sc
}

// rebuild applies all live observations to a fresh table in one batch and
// requires the resulting view to equal the incremental one.
func rebuild(t *testing.T, tb *pivot.Table) *pivot.View {
	t.Helper()
	live := tb.Live()
	ops := make([]pivot.Op, len(live))
	for i, obs := range live {
		ops[i] = pivot.Add(obs)
	}
	fresh := pivot.New()
	if _, err := fresh.Apply(ops); err != nil {
		t.Fatalf("rebuild failed: %v", err)
	}
	return fresh.View()
}

func requireViewEqual(t *testing.T, got, want *pivot.View) {
	t.Helper()
	if !reflect.DeepEqual(got.Schema, want.Schema) {
		t.Fatalf("schema mismatch: got %v want %v", got.Schema, want.Schema)
	}
	if !reflect.DeepEqual(got.Rows, want.Rows) {
		t.Fatalf("rows mismatch: got %v want %v", got.Rows, want.Rows)
	}
	if !reflect.DeepEqual(got.Cells, want.Cells) {
		t.Fatalf("cells mismatch: got %v want %v", got.Cells, want.Cells)
	}
}

func TestColumnInsertionShiftsOldIndices(t *testing.T) {
	tb := pivot.New()
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r1", ColKey: "b", Value: strptr("vb")}),
		pivot.Add(pivot.Observation{ID: "e2", RowKey: "r1", ColKey: "d", Value: strptr("vd")}),
	)
	oldView := tb.View()
	if !reflect.DeepEqual(oldView.Schema, []string{"b", "d"}) {
		t.Fatalf("unexpected old schema: %v", oldView.Schema)
	}

	// "a" sorts before every existing column, so all old indices move.
	sc := mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e3", RowKey: "r2", ColKey: "a", Value: strptr("va")}),
	)
	if !reflect.DeepEqual(sc.Schema, []string{"a", "b", "d"}) {
		t.Fatalf("unexpected new schema: %v", sc.Schema)
	}
	if !reflect.DeepEqual(sc.Mapping, []int{1, 2}) {
		t.Fatalf("unexpected mapping: %v", sc.Mapping)
	}

	// The old view keeps its old schema and old column positions.
	if !reflect.DeepEqual(oldView.Schema, []string{"b", "d"}) {
		t.Fatalf("old view schema changed: %v", oldView.Schema)
	}
	if got := oldView.Cell("r1", "b"); got.Kind != pivot.Value || got.Value != "vb" {
		t.Fatalf("old view cell changed: %+v", got)
	}
	if got := oldView.Cell("r2", "a"); got.Kind != pivot.Missing {
		t.Fatalf("old view should not know column a: %+v", got)
	}

	newView := tb.View()
	if got := newView.Cell("r1", "b"); got.Kind != pivot.Value || got.Value != "vb" {
		t.Fatalf("moved column lost its value: %+v", got)
	}
	if got := newView.Cell("r1", "a"); got.Kind != pivot.Missing {
		t.Fatalf("cell (r1,a) should be missing: %+v", got)
	}

	requireViewEqual(t, rebuild(t, tb), newView)
}

func TestSameCellRevokeRevealsFormer(t *testing.T) {
	tb := pivot.New()
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "ev2", RowKey: "r", ColKey: "c", Value: strptr("second")}),
		pivot.Add(pivot.Observation{ID: "ev1", RowKey: "r", ColKey: "c", Value: strptr("first")}),
		pivot.Add(pivot.Observation{ID: "ev3", RowKey: "r", ColKey: "c", Value: strptr("third")}),
	)

	// Byte order ev1 < ev2 < ev3: the last one wins regardless of add order.
	if got := tb.View().Cell("r", "c"); got.Kind != pivot.Value || got.Value != "third" {
		t.Fatalf("winner should be ev3: %+v", got)
	}

	mustApply(t, tb, pivot.Revoke("ev3"))
	if got := tb.View().Cell("r", "c"); got.Kind != pivot.Value || got.Value != "second" {
		t.Fatalf("revoke should reveal ev2: %+v", got)
	}

	mustApply(t, tb, pivot.Revoke("ev2"))
	if got := tb.View().Cell("r", "c"); got.Kind != pivot.Value || got.Value != "first" {
		t.Fatalf("revoke should reveal ev1: %+v", got)
	}

	// Revoking the last observation of the cell removes row and column.
	sc := mustApply(t, tb, pivot.Revoke("ev1"))
	if len(sc.Schema) != 0 || len(sc.Mapping) != 1 || sc.Mapping[0] != -1 {
		t.Fatalf("column should be gone: %+v", sc)
	}
	v := tb.View()
	if len(v.Rows) != 0 || len(v.Schema) != 0 {
		t.Fatalf("empty row/column should not be retained: %+v", v)
	}

	requireViewEqual(t, rebuild(t, tb), v)
}

func TestBatchRollsBackOnIllegalRevoke(t *testing.T) {
	tb := pivot.New()
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r1", ColKey: "c1", Value: strptr("v1")}),
	)
	before := tb.View()

	_, err := tb.Apply([]pivot.Op{
		pivot.Add(pivot.Observation{ID: "e2", RowKey: "r2", ColKey: "c2", Value: strptr("v2")}),
		pivot.Revoke("no-such-id"),
	})
	if !errors.Is(err, pivot.ErrMissingID) {
		t.Fatalf("expected ErrMissingID, got %v", err)
	}

	// The whole batch rolled back: e2 must not exist either.
	requireViewEqual(t, tb.View(), before)
	if got := tb.View().Cell("r2", "c2"); got.Kind != pivot.Missing {
		t.Fatalf("rolled-back add leaked into view: %+v", got)
	}

	// A revoke of an ID added earlier in the same batch is legal.
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e3", RowKey: "r3", ColKey: "c3", Value: strptr("v3")}),
		pivot.Revoke("e3"),
	)
	if got := tb.View().Cell("r3", "c3"); got.Kind != pivot.Missing {
		t.Fatalf("in-batch add+revoke should vanish: %+v", got)
	}
}

func TestDuplicateIDRejected(t *testing.T) {
	tb := pivot.New()
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r1", ColKey: "c1", Value: strptr("v1")}),
	)

	// Reuse across cells.
	_, err := tb.Apply([]pivot.Op{
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r2", ColKey: "c2", Value: strptr("x")}),
	})
	if !errors.Is(err, pivot.ErrDuplicateID) {
		t.Fatalf("expected ErrDuplicateID across cells, got %v", err)
	}

	// Reuse in the same cell.
	_, err = tb.Apply([]pivot.Op{
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r1", ColKey: "c1", Value: strptr("x")}),
	})
	if !errors.Is(err, pivot.ErrDuplicateID) {
		t.Fatalf("expected ErrDuplicateID in same cell, got %v", err)
	}

	// After revocation the ID is free again.
	mustApply(t, tb, pivot.Revoke("e1"))
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r9", ColKey: "c9", Value: strptr("reused")}),
	)
	if got := tb.View().Cell("r9", "c9"); got.Kind != pivot.Value || got.Value != "reused" {
		t.Fatalf("reused ID after revoke should work: %+v", got)
	}
}

func TestMissingIsNotNull(t *testing.T) {
	tb := pivot.New()
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r1", ColKey: "c1", Value: nil}),
		pivot.Add(pivot.Observation{ID: "e2", RowKey: "r2", ColKey: "c2", Value: strptr("v")}),
	)
	v := tb.View()

	if got := v.Cell("r1", "c1"); got.Kind != pivot.Null {
		t.Fatalf("explicit null expected, got %+v", got)
	}
	if got := v.Cell("r1", "c2"); got.Kind != pivot.Missing {
		t.Fatalf("missing expected, got %+v", got)
	}
	if got := v.Cell("r2", "c1"); got.Kind != pivot.Missing {
		t.Fatalf("missing expected, got %+v", got)
	}
	if pivot.Missing.String() != "missing" || pivot.Null.String() != "null" {
		t.Fatalf("kind strings wrong")
	}

	// A null observation still keeps its row and column alive.
	if !reflect.DeepEqual(v.Schema, []string{"c1", "c2"}) || !reflect.DeepEqual(v.Rows, []string{"r1", "r2"}) {
		t.Fatalf("null must not collapse row/column: %+v", v)
	}
}

func TestEmptyRowAndColumnLifetime(t *testing.T) {
	tb := pivot.New()
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "e1", RowKey: "r1", ColKey: "c1", Value: strptr("a")}),
		pivot.Add(pivot.Observation{ID: "e2", RowKey: "r1", ColKey: "c2", Value: strptr("b")}),
		pivot.Add(pivot.Observation{ID: "e3", RowKey: "r2", ColKey: "c1", Value: strptr("c")}),
	)

	// Revoking r1's last c1 observation keeps r1 (c2 remains) and c1 (r2 remains).
	sc := mustApply(t, tb, pivot.Revoke("e1"))
	if !reflect.DeepEqual(sc.Schema, []string{"c1", "c2"}) {
		t.Fatalf("c1 should survive via r2: %v", sc.Schema)
	}
	v := tb.View()
	if !reflect.DeepEqual(v.Rows, []string{"r1", "r2"}) {
		t.Fatalf("r1 should survive via c2: %v", v.Rows)
	}
	if got := v.Cell("r1", "c1"); got.Kind != pivot.Missing {
		t.Fatalf("revoked cell should be missing: %+v", got)
	}

	// Revoking e2 empties column c2 entirely: it leaves the schema.
	sc = mustApply(t, tb, pivot.Revoke("e2"))
	if !reflect.DeepEqual(sc.Schema, []string{"c1"}) {
		t.Fatalf("c2 should be gone: %v", sc.Schema)
	}
	if !reflect.DeepEqual(sc.Mapping, []int{0, -1}) {
		t.Fatalf("mapping should retire c2: %v", sc.Mapping)
	}

	requireViewEqual(t, rebuild(t, tb), tb.View())
}

func TestFullRebuildAfterMixedBatches(t *testing.T) {
	tb := pivot.New()
	mustApply(t, tb,
		pivot.Add(pivot.Observation{ID: "a", RowKey: "r1", ColKey: "m", Value: strptr("1")}),
		pivot.Add(pivot.Observation{ID: "b", RowKey: "r1", ColKey: "m", Value: strptr("2")}),
		pivot.Add(pivot.Observation{ID: "c", RowKey: "r2", ColKey: "z", Value: nil}),
	)
	mustApply(t, tb,
		pivot.Revoke("b"),
		pivot.Add(pivot.Observation{ID: "d", RowKey: "r1", ColKey: "a", Value: strptr("3")}),
		pivot.Add(pivot.Observation{ID: "e", RowKey: "r3", ColKey: "m", Value: strptr("4")}),
	)
	mustApply(t, tb, pivot.Revoke("c"))

	requireViewEqual(t, rebuild(t, tb), tb.View())
}
