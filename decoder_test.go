package dataeng

import (
	"reflect"
	"testing"
)

func TestIllegalStreamsRejected(t *testing.T) {
	tests := []struct {
		name   string
		tokens []Token
		rows   int
	}{
		{"r out of range", []Token{{R: 3, D: 0}}, 1},
		{"negative r", []Token{{R: -1, D: 0}}, 1},
		{"d out of range", []Token{{R: 0, D: 6}}, 1},
		{"negative d", []Token{{R: 0, D: -1}}, 1},
		{"first token r1", []Token{{R: 1, D: 2}, {R: 0, D: 0}}, 2},
		{"first token r2", []Token{{R: 2, D: 4}, {R: 0, D: 0}}, 2},
		{"r1 after low d", []Token{{R: 0, D: 0}, {R: 1, D: 2}}, 1},
		{"r1 before low d", []Token{{R: 0, D: 2}, {R: 1, D: 1}}, 1},
		{"r2 after low d", []Token{{R: 0, D: 4}, {R: 2, D: 4}, {R: 1, D: 2}, {R: 2, D: 4}}, 1},
		{"r2 before low d", []Token{{R: 0, D: 4}, {R: 2, D: 3}}, 1},
		{"value without d5", []Token{{R: 0, D: 3, Value: i64(1)}}, 1},
		{"d5 missing value", []Token{{R: 0, D: 5}}, 1},
		{"count mismatch extra", []Token{{R: 0, D: 0}, {R: 0, D: 0}}, 1},
		{"count mismatch fewer", []Token{{R: 0, D: 0}}, 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidateTokenStream(tt.tokens, tt.rows); err == nil {
				t.Fatal("ValidateTokenStream accepted illegal stream")
			}

			validator := NewLevelValidator()
			var sawError error
			for _, tok := range tt.tokens {
				if sawError = validator.Next(tok); sawError != nil {
					break
				}
			}
			if sawError == nil {
				sawError = validator.End(tt.rows)
			}
			if sawError == nil {
				t.Fatal("independent state machine accepted illegal stream")
			}

			if _, err := DecodeAll(tt.tokens, tt.rows); err == nil {
				t.Fatal("DecodeAll accepted illegal stream")
			}
		})
	}
}

func TestEmptyStream(t *testing.T) {
	if err := ValidateTokenStream(nil, 0); err != nil {
		t.Fatalf("empty stream with zero rows: %v", err)
	}

	decoder, err := NewDecoder(0)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	if rows, err := decoder.Finalize(); err != nil || rows != nil {
		t.Fatalf("Finalize empty = (%v, %v), want (nil, nil)", rows, err)
	}

	if err := ValidateTokenStream(nil, 1); err == nil {
		t.Fatal("empty stream must not satisfy a one-row expectation")
	}
	if _, err := NewDecoder(-1); err == nil {
		t.Fatal("negative wantRows must be rejected")
	}
}

func TestCrossBatchAtEveryCut(t *testing.T) {
	rows := []Row{
		{},
		{Outer: &[][]*int64{{i64(1), nil}, nil, {i64(2)}}},
		{Outer: &[][]*int64{nil, {}, {nil}}},
	}
	tokens := EncodeRows(rows)

	for cut := 0; cut <= len(tokens); cut++ {
		decoder, err := NewDecoder(len(rows))
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}

		var got []Row
		published, err := decoder.DecodeBatch(tokens[:cut])
		if err != nil {
			t.Fatalf("cut %d first batch: %v", cut, err)
		}
		got = append(got, published...)

		empty, err := decoder.DecodeBatch(nil)
		if err != nil || empty != nil {
			t.Fatalf("cut %d empty batch = (%v, %v)", cut, empty, err)
		}

		published, err = decoder.DecodeBatch(tokens[cut:])
		if err != nil {
			t.Fatalf("cut %d second batch: %v", cut, err)
		}
		got = append(got, published...)

		final, err := decoder.Finalize()
		if err != nil {
			t.Fatalf("cut %d Finalize: %v", cut, err)
		}
		got = append(got, final...)

		if !reflect.DeepEqual(got, rows) {
			t.Fatalf("cut %d round trip:\n got %+v\nwant %+v", cut, got, rows)
		}
	}
}

func TestFailedBatchRollsBackAndPublishesNothing(t *testing.T) {
	rows := []Row{
		{Outer: &[][]*int64{{i64(1), i64(2)}}},
		{Outer: &[][]*int64{{i64(3)}}},
		{Outer: &[][]*int64{{nil}}},
	}
	tokens := EncodeRows(rows)

	decoder, err := NewDecoder(len(rows))
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}

	first, err := decoder.DecodeBatch(tokens[:3])
	if err != nil {
		t.Fatalf("first batch: %v", err)
	}
	if len(first) != 1 || !reflect.DeepEqual(first[0], rows[0]) {
		t.Fatalf("first batch published %+v", first)
	}

	bad := append([]Token{}, tokens[3:]...)
	bad[0] = Token{R: 9, D: 4}
	if _, err := decoder.DecodeBatch(bad); err == nil {
		t.Fatal("illegal batch must fail")
	}

	if len(decoder.completed) != 1 || !reflect.DeepEqual(decoder.completed[0], rows[0]) {
		t.Fatalf("completed rows after rollback: %+v", decoder.completed)
	}
	wantStaged := []Token{{R: 0, D: 5, Value: i64(3)}}
	if got := EncodeRows([]Row{decoder.current.toRow()}); !reflect.DeepEqual(got, wantStaged) {
		t.Fatalf("staged row after rollback = %+v, want %+v", got, wantStaged)
	}

	var got []Row
	for start := 3; start < len(tokens); {
		end := start + 2
		if end > len(tokens) {
			end = len(tokens)
		}
		published, err := decoder.DecodeBatch(tokens[start:end])
		if err != nil {
			t.Fatalf("replay batch [%d:%d]: %v", start, end, err)
		}
		got = append(got, published...)
		start = end
	}
	final, err := decoder.Finalize()
	if err != nil {
		t.Fatalf("Finalize: %v", err)
	}
	got = append(append(first, got...), final...)
	if !reflect.DeepEqual(got, rows) {
		t.Fatalf("recovered rows:\n got %+v\nwant %+v", got, rows)
	}
}

func TestFinalizeConfirmsOnlyAtEnd(t *testing.T) {
	tokens := []Token{{R: 0, D: 5, Value: i64(1)}, {R: 0, D: 0}}

	decoder, err := NewDecoder(3)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	if _, err := decoder.DecodeBatch(tokens); err != nil {
		t.Fatalf("DecodeBatch: %v", err)
	}
	if _, err := decoder.Finalize(); err == nil {
		t.Fatal("Finalize must reject a stream short of wantRows")
	}
	// A failed Finalize leaves the decoder open: the missing row can
	// still arrive in a later batch before the confirming Finalize.
	if _, err := decoder.DecodeBatch([]Token{{R: 0, D: 0}}); err != nil {
		t.Fatalf("DecodeBatch after failed Finalize should remain open: %v", err)
	}
	if _, err := decoder.Finalize(); err != nil {
		t.Fatalf("Finalize after completing the missing row: %v", err)
	}

	decoder2, err := NewDecoder(2)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	published, err := decoder2.DecodeBatch(tokens)
	if err != nil {
		t.Fatalf("DecodeBatch: %v", err)
	}
	if len(published) != 1 {
		t.Fatalf("only row 0 should be published, got %d", len(published))
	}
	final, err := decoder2.Finalize()
	if err != nil {
		t.Fatalf("Finalize: %v", err)
	}
	if len(final) != 1 {
		t.Fatalf("staged last row = %+v", final)
	}
	if _, err := decoder2.DecodeBatch(nil); err == nil {
		t.Fatal("DecodeBatch after Finalize must be rejected")
	}
	if _, err := decoder2.Finalize(); err == nil {
		t.Fatal("double Finalize must be rejected")
	}
}

func TestValidatorSnapshotRollback(t *testing.T) {
	validator := NewLevelValidator()
	if err := validator.Next(Token{R: 0, D: 5, Value: i64(1)}); err != nil {
		t.Fatalf("Next: %v", err)
	}
	state := validator.snapshot()
	if err := validator.Next(Token{R: 9, D: 0}); err == nil {
		t.Fatal("expected range error")
	}
	if validator.Rows() != 1 {
		t.Fatalf("illegal token changed row count: %d", validator.Rows())
	}

	if err := validator.Next(Token{R: 2, D: 4}); err != nil {
		t.Fatalf("Next after snapshot point: %v", err)
	}
	if validator.Rows() != 1 {
		t.Fatalf("rows = %d, want 1", validator.Rows())
	}

	validator.restore(state)
	if validator.Rows() != 1 {
		t.Fatalf("rows after restore = %d, want 1", validator.Rows())
	}
	if err := validator.Next(Token{R: 2, D: 4}); err != nil {
		t.Fatalf("Next after explicit restore: %v", err)
	}
	validator.Reset()
	if validator.Rows() != 0 {
		t.Fatalf("rows after Reset = %d, want 0", validator.Rows())
	}
}
