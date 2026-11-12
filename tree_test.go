package dataeng

import (
	"math/rand"
	"reflect"
	"testing"
)

func generateRow(rng *rand.Rand) Row {
	switch rng.Intn(6) {
	case 0:
		return Row{}
	case 1:
		outer := make([][]*int64, 0)
		return Row{Outer: &outer}
	}

	outerCount := rng.Intn(5)
	outer := make([][]*int64, 0, outerCount)
	for i := 0; i < outerCount; i++ {
		switch rng.Intn(6) {
		case 0:
			outer = append(outer, nil)
		case 1:
			outer = append(outer, make([]*int64, 0))
		default:
			leafCount := rng.Intn(5)
			inner := make([]*int64, 0, leafCount)
			for j := 0; j < leafCount; j++ {
				if rng.Intn(3) == 0 {
					inner = append(inner, nil)
				} else {
					value := rng.Int63n(1_000_000) - 500_000
					inner = append(inner, &value)
				}
			}
			outer = append(outer, inner)
		}
	}
	return Row{Outer: &outer}
}

func TestGeneratedTreesRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))

	for iteration := 0; iteration < 500; iteration++ {
		rowCount := rng.Intn(8)
		rows := make([]Row, rowCount)
		for i := range rows {
			rows[i] = generateRow(rng)
		}

		tokens := EncodeRows(rows)

		startedRows := 0
		for _, tok := range tokens {
			if tok.R == 0 {
				startedRows++
			}
		}
		if startedRows != rowCount {
			t.Fatalf("iteration %d: encoded %d row starts for %d rows", iteration, startedRows, rowCount)
		}
		if err := ValidateTokenStream(tokens, rowCount); err != nil {
			t.Fatalf("iteration %d: encoder produced an invalid stream: %v", iteration, err)
		}

		decoded, err := DecodeAll(tokens, rowCount)
		if err != nil {
			t.Fatalf("iteration %d: DecodeAll: %v", iteration, err)
		}
		if !reflect.DeepEqual(decoded, rows) {
			if !(rowCount == 0 && len(decoded) == 0) {
				t.Fatalf("iteration %d round trip mismatch:\n got %+v\nwant %+v", iteration, decoded, rows)
			}
		}
	}
}

func TestGeneratedTreesRandomBatches(t *testing.T) {
	rng := rand.New(rand.NewSource(99))

	for iteration := 0; iteration < 200; iteration++ {
		rowCount := rng.Intn(6)
		rows := make([]Row, rowCount)
		for i := range rows {
			rows[i] = generateRow(rng)
		}
		tokens := EncodeRows(rows)

		decoder, err := NewDecoder(rowCount)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}

		var got []Row
		for start := 0; start < len(tokens); {
			step := 1 + rng.Intn(4)
			end := start + step
			if end > len(tokens) {
				end = len(tokens)
			}
			published, err := decoder.DecodeBatch(tokens[start:end])
			if err != nil {
				t.Fatalf("iteration %d batch [%d:%d]: %v", iteration, start, end, err)
			}
			got = append(got, published...)
			start = end
		}

		final, err := decoder.Finalize()
		if err != nil {
			t.Fatalf("iteration %d Finalize: %v", iteration, err)
		}
		got = append(got, final...)

		if !reflect.DeepEqual(got, rows) && !(rowCount == 0 && len(got) == 0) {
			t.Fatalf("iteration %d batched round trip mismatch:\n got %+v\nwant %+v", iteration, got, rows)
		}
	}
}

func TestGeneratedTreeFailedBatchRollback(t *testing.T) {
	rng := rand.New(rand.NewSource(7))

	for iteration := 0; iteration < 100; iteration++ {
		rowCount := 2 + rng.Intn(4)
		rows := make([]Row, rowCount)
		for i := range rows {
			rows[i] = generateRow(rng)
		}
		tokens := EncodeRows(rows)
		if len(tokens) < 2 {
			continue
		}

		cut := 1 + rng.Intn(len(tokens)-1)
		decoder, err := NewDecoder(rowCount)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		prefix, err := decoder.DecodeBatch(tokens[:cut])
		if err != nil {
			t.Fatalf("prefix batch: %v", err)
		}

		state := decoder.snapshot()
		bad := append([]Token{}, tokens[cut:]...)
		if rng.Intn(2) == 0 {
			bad[0] = Token{R: 1, D: 0}
		} else {
			bad[rng.Intn(len(bad))] = Token{R: 0, D: 9}
		}
		if _, err := decoder.DecodeBatch(bad); err == nil {
			t.Fatalf("iteration %d: bad batch was accepted", iteration)
		}

		restored := decoder.snapshot()
		if !reflect.DeepEqual(restored, state) {
			t.Fatalf("iteration %d: state after failed batch differs from pre-batch snapshot", iteration)
		}

		published, err := decoder.DecodeBatch(tokens[cut:])
		if err != nil {
			t.Fatalf("valid retry after rollback: %v", err)
		}
		final, err := decoder.Finalize()
		if err != nil {
			t.Fatalf("Finalize: %v", err)
		}
		got := append(append([]Row{}, prefix...), published...)
		got = append(got, final...)
		if !reflect.DeepEqual(got, rows) && !(rowCount == 0 && len(got) == 0) {
			t.Fatalf("iteration %d: recovery mismatch", iteration)
		}
	}
}
