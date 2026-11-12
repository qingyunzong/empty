package dataeng

import (
	"errors"
	"testing"
)

func mustHandle(t *testing.T, d *Decoder, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func assertErrorIs(t *testing.T, err error, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("expected error wrapping %v, got %v", target, err)
	}
}

// TestInterleavedTables mixes two tables in one batch: each row must be
// decoded against its own table and generation.
func TestInterleavedTables(t *testing.T) {
	d := NewDecoder()
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "users", Generation: 1, Columns: []Column{
		{ID: "id", Type: TypeInt64},
		{ID: "name", Type: TypeString},
	}}))
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 2, Table: "orders", Generation: 1, Columns: []Column{
		{ID: "oid", Type: TypeInt64},
		{ID: "paid", Type: TypeBool},
	}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 3, Table: "users", Generation: 1, Values: []any{int64(7), "ada"}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 4, Table: "orders", Generation: 1, Values: []any{int64(100), true}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 5, Table: "users", Generation: 1, Values: []any{int64(8), "bob"}}))

	batch, err := d.Commit(CommitEvent{Seq: 6})
	if err != nil {
		t.Fatalf("commit failed: %v", err)
	}
	if len(batch.Schemas) != 2 || len(batch.Records) != 3 {
		t.Fatalf("unexpected batch size: %+v", batch)
	}
	if batch.Records[0].Table != "users" || batch.Records[1].Table != "orders" || batch.Records[2].Table != "users" {
		t.Fatalf("records not kept in global sequence order: %+v", batch.Records)
	}
	if got := batch.Records[1].Columns["oid"]; got != int64(100) {
		t.Fatalf("orders row oid = %v, want 100", got)
	}
	if got := batch.Records[1].Columns["paid"]; got != true {
		t.Fatalf("orders row paid = %v, want true", got)
	}
}

// TestRowBeforeSchema stages rows referencing an unseen generation and
// only reveals the schema later in the same batch.
func TestRowBeforeSchema(t *testing.T) {
	d := NewDecoder()
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 1, Table: "t", Generation: 3, Values: []any{int64(1), "x"}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 2, Table: "t", Generation: 3, Values: []any{int64(2), "y"}}))
	if _, ok := d.Schema("t", 3); ok {
		t.Fatal("pending schema must not be visible before commit")
	}
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 3, Table: "t", Generation: 3, Columns: []Column{
		{ID: "a", Type: TypeInt64},
		{ID: "b", Type: TypeString},
	}}))

	batch, err := d.Commit(CommitEvent{Seq: 4})
	if err != nil {
		t.Fatalf("commit failed: %v", err)
	}
	if batch.Records[0].Columns["a"] != int64(1) || batch.Records[0].Columns["b"] != "x" {
		t.Fatalf("row resolved against wrong schema: %+v", batch.Records[0].Columns)
	}
	if _, ok := d.Schema("t", 3); !ok {
		t.Fatal("committed schema should be queryable")
	}
}

// TestColumnReorder reorders and changes columns between generations:
// values are mapped by stable ID, never by positional index.
func TestColumnReorder(t *testing.T) {
	d := NewDecoder()
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "t", Generation: 1, Columns: []Column{
		{ID: "a", Type: TypeInt64},
		{ID: "b", Type: TypeString},
		{ID: "c", Type: TypeBool},
	}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 2, Table: "t", Generation: 1, Values: []any{int64(1), "one", true}}))
	if _, err := d.Commit(CommitEvent{Seq: 3}); err != nil {
		t.Fatalf("first commit failed: %v", err)
	}

	// Generation 2: same IDs reordered, "c" dropped, new "d" appended.
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 4, Table: "t", Generation: 2, Columns: []Column{
		{ID: "b", Type: TypeString},
		{ID: "a", Type: TypeInt64},
		{ID: "d", Type: TypeBool},
	}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 5, Table: "t", Generation: 2, Values: []any{"two", int64(2), false}}))
	// A late row still targets the committed generation 1.
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 6, Table: "t", Generation: 1, Values: []any{int64(9), "nine", nil}}))

	batch, err := d.Commit(CommitEvent{Seq: 7})
	if err != nil {
		t.Fatalf("second commit failed: %v", err)
	}
	rec := batch.Records[0]
	if rec.Columns["b"] != "two" || rec.Columns["a"] != int64(2) || rec.Columns["d"] != false {
		t.Fatalf("reordered columns cross-wired values: %+v", rec.Columns)
	}
	if _, ok := rec.Columns["c"]; ok {
		t.Fatalf("dropped column c must not appear: %+v", rec.Columns)
	}
	old := batch.Records[1]
	if old.Generation != 1 || old.Columns["a"] != int64(9) || old.Columns["c"] != nil {
		t.Fatalf("generation 1 row decoded incorrectly: %+v", old.Columns)
	}
}

// TestCommitRollbackTypeError makes one bad row fail the commit; the
// schemas and good rows of that batch must both be discarded while
// previously committed state survives.
func TestCommitRollbackTypeError(t *testing.T) {
	d := NewDecoder()
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "t", Generation: 1, Columns: []Column{
		{ID: "a", Type: TypeInt64},
	}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 2, Table: "t", Generation: 1, Values: []any{int64(1)}}))
	if _, err := d.Commit(CommitEvent{Seq: 3}); err != nil {
		t.Fatalf("baseline commit failed: %v", err)
	}

	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 4, Table: "t", Generation: 2, Columns: []Column{
		{ID: "a", Type: TypeInt64},
		{ID: "b", Type: TypeString},
	}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 5, Table: "t", Generation: 2, Values: []any{int64(2), "ok"}}))
	// string where int64 is required.
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 6, Table: "t", Generation: 2, Values: []any{"nope", "bad"}}))

	_, err := d.Commit(CommitEvent{Seq: 7})
	assertErrorIs(t, err, ErrTypeMismatch)

	// Generation 2 schema and rows were rolled back.
	if _, ok := d.Schema("t", 2); ok {
		t.Fatal("failed batch must not publish its schema")
	}
	if s, ok := d.Schema("t", 1); !ok || s.Generation != 1 {
		t.Fatal("previously committed generation must survive rollback")
	}

	// The decoder keeps accepting events on a fresh batch and global
	// sequence enforcement still applies after the rejected commit.
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 8, Table: "t", Generation: 1, Values: []any{int64(3)}}))
	batch, err := d.Commit(CommitEvent{Seq: 9})
	if err != nil {
		t.Fatalf("post-rollback commit failed: %v", err)
	}
	if len(batch.Records) != 1 || batch.Records[0].Columns["a"] != int64(3) {
		t.Fatalf("unexpected post-rollback batch: %+v", batch)
	}
}

// TestGenerationOrdering covers increasing generations inside a batch
// and across commits, including duplicate announcements.
func TestGenerationOrdering(t *testing.T) {
	t.Run("decreasing within batch", func(t *testing.T) {
		d := NewDecoder()
		mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "t", Generation: 2, Columns: []Column{{ID: "a", Type: TypeBool}}}))
		mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 2, Table: "t", Generation: 1, Columns: []Column{{ID: "a", Type: TypeBool}}}))
		_, err := d.Commit(CommitEvent{Seq: 3})
		assertErrorIs(t, err, ErrGenerationOrder)
	})
	t.Run("duplicate within batch", func(t *testing.T) {
		d := NewDecoder()
		cols := []Column{{ID: "a", Type: TypeBool}}
		mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "t", Generation: 1, Columns: cols}))
		mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 2, Table: "t", Generation: 1, Columns: cols}))
		_, err := d.Commit(CommitEvent{Seq: 3})
		assertErrorIs(t, err, ErrDuplicateSchema)
	})
	t.Run("regression across commits", func(t *testing.T) {
		d := NewDecoder()
		mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "t", Generation: 2, Columns: []Column{{ID: "a", Type: TypeBool}}}))
		if _, err := d.Commit(CommitEvent{Seq: 2}); err != nil {
			t.Fatal(err)
		}
		mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 3, Table: "t", Generation: 2, Columns: []Column{{ID: "a", Type: TypeBool}}}))
		_, err := d.Commit(CommitEvent{Seq: 4})
		assertErrorIs(t, err, ErrGenerationOrder)
	})
}

// TestSequenceStrictlyIncreasing verifies the global sequence gate,
// including after a rolled-back commit.
func TestSequenceStrictlyIncreasing(t *testing.T) {
	d := NewDecoder()
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 10, Table: "t", Generation: 1, Columns: []Column{{ID: "a", Type: TypeBool}}}))
	err := d.HandleRow(RowEvent{Seq: 10, Table: "t", Generation: 1, Values: []any{true}})
	assertErrorIs(t, err, ErrSequence)
	err = d.HandleRow(RowEvent{Seq: 9, Table: "t", Generation: 1, Values: []any{true}})
	assertErrorIs(t, err, ErrSequence)

	// Rejecting an event does not stage it; a valid next seq works.
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 11, Table: "t", Generation: 1, Values: []any{true}}))
	if _, err := d.Commit(CommitEvent{Seq: 12}); err != nil {
		t.Fatal(err)
	}
	_, err = d.Commit(CommitEvent{Seq: 12})
	assertErrorIs(t, err, ErrSequence)
}

// TestNullableAndExactTypes checks nil values and the strict Go types.
func TestNullableAndExactTypes(t *testing.T) {
	d := NewDecoder()
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "t", Generation: 1, Columns: []Column{
		{ID: "i", Type: TypeInt64},
		{ID: "s", Type: TypeString},
		{ID: "b", Type: TypeBool},
	}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 2, Table: "t", Generation: 1, Values: []any{nil, nil, nil}}))
	batch, err := d.Commit(CommitEvent{Seq: 3})
	if err != nil {
		t.Fatalf("nil values should be accepted: %v", err)
	}
	rec := batch.Records[0].Columns
	if rec["i"] != nil || rec["s"] != nil || rec["b"] != nil {
		t.Fatalf("nil values not preserved: %+v", rec)
	}

	// int is not int64, and mismatched scalar kinds are rejected.
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 4, Table: "t", Generation: 1, Values: []any{1, nil, nil}}))
	_, err = d.Commit(CommitEvent{Seq: 5})
	assertErrorIs(t, err, ErrTypeMismatch)

	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 6, Table: "t", Generation: 1, Values: []any{nil, true, nil}}))
	_, err = d.Commit(CommitEvent{Seq: 7})
	assertErrorIs(t, err, ErrTypeMismatch)
}

// TestUnresolvedGenerationRejectsBatch keeps rows for an unknown
// generation staged until commit, then rejects the whole batch.
func TestUnresolvedGenerationRejectsBatch(t *testing.T) {
	d := NewDecoder()
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 1, Table: "t", Generation: 5, Values: []any{int64(1)}}))
	_, err := d.Commit(CommitEvent{Seq: 2})
	assertErrorIs(t, err, ErrUnknownGeneration)

	// After rejection the same stream continues; providing the schema in
	// the next batch resolves the row.
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 3, Table: "t", Generation: 5, Columns: []Column{
		{ID: "a", Type: TypeInt64},
	}}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 4, Table: "t", Generation: 5, Values: []any{int64(2)}}))
	batch, err := d.Commit(CommitEvent{Seq: 5})
	if err != nil {
		t.Fatalf("commit after supplying schema failed: %v", err)
	}
	if len(batch.Records) != 1 || batch.Records[0].Columns["a"] != int64(2) {
		t.Fatalf("unexpected resolved batch: %+v", batch)
	}
}

// TestArityAndDefensiveCopies covers value-count mismatch and ensures
// caller slices cannot mutate decoder state.
func TestArityAndDefensiveCopies(t *testing.T) {
	d := NewDecoder()
	cols := []Column{{ID: "a", Type: TypeInt64}, {ID: "b", Type: TypeString}}
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 1, Table: "t", Generation: 1, Columns: cols}))
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 2, Table: "t", Generation: 1, Values: []any{int64(1)}}))
	_, err := d.Commit(CommitEvent{Seq: 3})
	assertErrorIs(t, err, ErrArity)

	// The failed commit rolled back the schema too; re-announce it.
	mustHandle(t, d, d.HandleSchema(SchemaEvent{Seq: 4, Table: "t", Generation: 1, Columns: cols}))
	vals := []any{int64(7), "z"}
	mustHandle(t, d, d.HandleRow(RowEvent{Seq: 5, Table: "t", Generation: 1, Values: vals}))
	cols[0].ID = "mutated"
	vals[0] = "mutated"
	batch, err := d.Commit(CommitEvent{Seq: 6})
	if err != nil {
		t.Fatalf("commit failed: %v", err)
	}
	if batch.Records[0].Columns["a"] != int64(7) || batch.Records[0].Columns["b"] != "z" {
		t.Fatalf("caller mutation leaked into decoded record: %+v", batch.Records[0].Columns)
	}
}
