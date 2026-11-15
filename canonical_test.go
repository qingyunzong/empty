package dataeng

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func mustCanonical(t *testing.T, value Value) string {
	t.Helper()
	encoded, err := canonicalValue(value)
	if err != nil {
		t.Fatalf("canonicalValue(%#v): %v", value, err)
	}
	return string(encoded)
}

func TestCanonicalNumericEquivalence(t *testing.T) {
	values := []Value{1, int8(1), int16(1), int32(1), int64(1),
		uint(1), uint8(1), uint16(1), uint32(1), uint64(1),
		float32(1), float64(1), json.Number("1.0")}
	want := mustCanonical(t, values[0])
	for _, value := range values[1:] {
		if got := mustCanonical(t, value); got != want {
			t.Fatalf("canonicalValue(%#v) = %q, want %q", value, got, want)
		}
	}
	if mustCanonical(t, 1) == mustCanonical(t, "1") {
		t.Fatal("numeric and string values canonicalized to the same value")
	}
}

func TestCanonicalCompositeIsDeterministic(t *testing.T) {
	left := map[string]any{"a": 1, "b": []any{"x", true}}
	right := map[string]any{"b": []any{"x", true}, "a": float64(1)}
	if got, want := mustCanonical(t, left), mustCanonical(t, right); got != want {
		t.Fatalf("map insertion order changed canonical value: %q != %q", got, want)
	}

	first := time.Date(2026, 1, 2, 3, 4, 5, 6, time.FixedZone("x", 8*60*60))
	second := first.UTC()
	if got, want := mustCanonical(t, first), mustCanonical(t, second); got != want {
		t.Fatalf("time zone changed canonical value: %q != %q", got, want)
	}
}

func TestCanonicalRejectsCycles(t *testing.T) {
	type node struct {
		Next any
	}
	cyclic := &node{}
	cyclic.Next = cyclic
	if _, err := canonicalValue(cyclic); !errors.Is(err, errUnsupportedValue) {
		t.Fatalf("cycle error = %v, want errUnsupportedValue", err)
	}
}

func TestKeyHelpers(t *testing.T) {
	left := Key{Table: "t", SchemaGeneration: 1, Columns: []string{"id"}, Values: []Value{1}}
	right := Key{Table: "t", SchemaGeneration: 1, Columns: []string{"id"}, Values: []Value{float64(1)}}
	if !left.Equal(right) {
		t.Fatal("canonical keys should be equal")
	}
	if left.String() == "" || left.Map()["id"] != 1 {
		t.Fatalf("unexpected key helpers: %q %#v", left.String(), left.Map())
	}
}

func TestConstructorAndMethodAliases(t *testing.T) {
	engine := NewMerger()
	if engine == nil || New() == nil {
		t.Fatal("constructor alias returned nil")
	}
	transaction := insertTx("tx-1", insertChange(1, Image{"id": 1}))
	if result, err := engine.ApplyTransaction(transaction); err != nil || result.ChangeCount != 1 {
		t.Fatalf("ApplyTransaction: result=%+v err=%v", result, err)
	}
	if _, err := engine.Merge(transaction); err != nil {
		t.Fatalf("replayed Merge: %v", err)
	}
	if _, ok := engine.Schema(usersTable, usersGen); !ok {
		t.Fatal("inline schema was not visible through Schema")
	}

	var zero Engine
	if err := zero.RegisterSchema(Schema{
		Table:      usersTable,
		Generation: usersGen,
		PrimaryKey: []string{"id"},
	}); err != nil {
		t.Fatalf("zero-value RegisterSchema: %v", err)
	}
	if _, err := zero.Apply(insertTx("tx-zero", insertChange(1, Image{"id": 1}))); err != nil {
		t.Fatalf("zero-value Apply: %v", err)
	}
}

func TestRestoreRejectsUnknownVersionAtomically(t *testing.T) {
	engine := NewEngine()
	applyOK(t, engine, insertTx("tx-1", insertChange(1, Image{"id": 1})))

	if err := engine.Restore(Snapshot{Version: 999}); !errors.Is(err, ErrInvalidTransaction) {
		t.Fatalf("Restore error = %v, want ErrInvalidTransaction", err)
	}
	if rows := engine.Rows(usersTable, usersGen); len(rows) != 1 {
		t.Fatalf("invalid restore changed state: %#v", rows)
	}
}
