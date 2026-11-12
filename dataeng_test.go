package dataeng

import (
	"errors"
	"math/rand"
	"sync"
	"testing"
)

func assertTriEqual(t *testing.T, got *triVec, want []tri, source string) {
	t.Helper()
	if got.rows != len(want) {
		t.Fatalf("row count mismatch: got %d want %d (expr %q)", got.rows, len(want), source)
	}
	for row, expected := range want {
		if actual := got.get(row); actual != expected {
			t.Fatalf("row %d tri mismatch: got %v want %v (expr %q)",
				row, actual, expected, source)
		}
	}
}

func countTrue(values []tri) int {
	count := 0
	for _, value := range values {
		if value == triTrue {
			count++
		}
	}
	return count
}

// TestDifferentialRandom compares the encoded bitmap engine against the
// decoded row-by-row interpreter over many random nested expressions and
// batches, including fully null columns and repeated dictionary values.
func TestDifferentialRandom(t *testing.T) {
	scenarios := []struct {
		name string
		opts batchOptions
	}{
		{"mixed", batchOptions{}},
		{"all_null", batchOptions{allNull: true}},
		{"duplicate_dictionary", batchOptions{dupDictionary: true}},
		{"all_null_and_duplicates", batchOptions{allNull: true, dupDictionary: true}},
	}
	for seed := int64(1); seed <= 80; seed++ {
		rng := rand.New(rand.NewSource(seed))
		schema := genSchema(rng)
		exprNode := genBool(rng, schema, 4)
		source := formatNode(exprNode)
		compiled, err := Compile(schema, source)
		if err != nil {
			t.Fatalf("seed %d: compile %q: %v", seed, source, err)
		}
		for _, scenario := range scenarios {
			rowCount := rng.Intn(40)
			batch := genBatch(rng, schema, rowCount, scenario.opts)

			bitmap, err := compiled.Evaluate(batch)
			if err != nil {
				t.Fatalf("seed %d scenario %s: evaluate: %v", seed, scenario.name, err)
			}
			decoded, err := decodeBatch(schema, batch)
			if err != nil {
				t.Fatalf("seed %d scenario %s: reference decode: %v", seed, scenario.name, err)
			}
			want := evalReference(exprNode, decoded)
			gotVec := compiled.plan.eval(batch, rowCount)
			assertTriEqual(t, gotVec, want, source)

			for row, expected := range want {
				if bitmap.Get(row) != (expected == triTrue) {
					t.Fatalf("seed %d scenario %s row %d: selected=%v want tri=%v (expr %q)",
						seed, scenario.name, row, bitmap.Get(row), expected, source)
				}
			}
			if len(bitmap.SelectedRows()) != countTrue(want) {
				t.Fatalf("seed %d scenario %s: SelectedRows count mismatch", seed, scenario.name)
			}
		}
	}
}

// TestEmptyBatch covers the zero-row boundary for both engines.
func TestEmptyBatch(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{"c0": TypeInt64}}
	compiled, err := Compile(schema, "c0 = 1")
	if err != nil {
		t.Fatal(err)
	}
	batch := &Batch{RowCount: 0, Columns: map[string]any{
		"c0": &Int64Column{Dict: []int64{1}, Values: nil},
	}}
	bitmap, err := compiled.Evaluate(batch)
	if err != nil {
		t.Fatal(err)
	}
	if bitmap.Rows() != 0 || len(bitmap.SelectedRows()) != 0 {
		t.Fatalf("empty batch produced selections: %+v", bitmap)
	}
}

// TestInvalidUnvisitedColumn ensures structural validation always inspects
// every schema column, even columns the predicate never references, and that
// a malformed batch is rejected as a whole rather than row by row.
func TestInvalidUnvisitedColumn(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{
		"used":   TypeInt64,
		"unused": TypeString,
	}}
	compiled, err := Compile(schema, "used = 1")
	if err != nil {
		t.Fatal(err)
	}
	goodInts := &Int64Column{Dict: []int64{1, 2}, Values: []int32{0, 1, -1}}

	cases := []struct {
		name    string
		batch   *Batch
		wantErr error
	}{
		{
			name: "unvisited column missing",
			batch: &Batch{RowCount: 3, Columns: map[string]any{
				"used": goodInts,
			}},
			wantErr: ErrInvalidBatch,
		},
		{
			name: "unvisited column wrong type",
			batch: &Batch{RowCount: 3, Columns: map[string]any{
				"used":   goodInts,
				"unused": &Int64Column{Dict: []int64{1}, Values: []int32{0, 0, 0}},
			}},
			wantErr: ErrInvalidBatch,
		},
		{
			name: "unvisited column bad index",
			batch: &Batch{RowCount: 3, Columns: map[string]any{
				"used":   goodInts,
				"unused": &StringColumn{Dict: []string{"x"}, Values: []int32{0, 5, -1}},
			}},
			wantErr: ErrInvalidBatch,
		},
		{
			name: "unvisited column index count mismatch",
			batch: &Batch{RowCount: 3, Columns: map[string]any{
				"used":   goodInts,
				"unused": &StringColumn{Dict: []string{"x"}, Values: []int32{0, -1}},
			}},
			wantErr: ErrInvalidBatch,
		},
		{
			name:    "nil batch",
			batch:   nil,
			wantErr: ErrInvalidBatch,
		},
		{
			name: "negative row count",
			batch: &Batch{RowCount: -1, Columns: map[string]any{
				"used":   goodInts,
				"unused": &StringColumn{Dict: []string{"x"}, Values: []int32{}},
			}},
			wantErr: ErrInvalidBatch,
		},
		{
			name: "visited column bad index",
			batch: &Batch{RowCount: 3, Columns: map[string]any{
				"used":   &Int64Column{Dict: []int64{1}, Values: []int32{0, -2, 0}},
				"unused": &StringColumn{Dict: []string{"x"}, Values: []int32{0, 0, 0}},
			}},
			wantErr: ErrInvalidBatch,
		},
		{
			name: "typed nil column",
			batch: &Batch{RowCount: 3, Columns: map[string]any{
				"used":   goodInts,
				"unused": (*StringColumn)(nil),
			}},
			wantErr: ErrInvalidBatch,
		},
		{
			name: "unsupported column payload",
			batch: &Batch{RowCount: 3, Columns: map[string]any{
				"used":   goodInts,
				"unused": "not-a-column",
			}},
			wantErr: ErrInvalidBatch,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := compiled.Evaluate(tc.batch)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("got %v, want error wrapping %v", err, tc.wantErr)
			}
		})
	}
}

// TestAllNullColumns pins three-valued behavior when every value is null.
func TestAllNullColumns(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{"n": TypeInt64}}
	batch := &Batch{RowCount: 2, Columns: map[string]any{
		"n": &Int64Column{Dict: []int64{1, 2}, Values: []int32{-1, -1}},
	}}
	cases := []struct {
		source string
		want   []tri
	}{
		{"n = 1", []tri{triUnknown, triUnknown}},
		{"n < 1", []tri{triUnknown, triUnknown}},
		{"n <= 1", []tri{triUnknown, triUnknown}},
		{"n IS NULL", []tri{triTrue, triTrue}},
		{"NOT n IS NULL", []tri{triFalse, triFalse}},
		{"NOT n = 1", []tri{triUnknown, triUnknown}},
		{"n = 1 AND n IS NULL", []tri{triUnknown, triUnknown}},
		{"n = 1 OR n IS NULL", []tri{triTrue, triTrue}},
		{"n = 1 OR NOT n IS NULL", []tri{triUnknown, triUnknown}},
	}
	for _, tc := range cases {
		compiled, err := Compile(schema, tc.source)
		if err != nil {
			t.Fatalf("compile %q: %v", tc.source, err)
		}
		bitmap, err := compiled.Evaluate(batch)
		if err != nil {
			t.Fatalf("evaluate %q: %v", tc.source, err)
		}
		got := compiled.plan.eval(batch, 2)
		assertTriEqual(t, got, tc.want, tc.source)
		for row, expected := range tc.want {
			if bitmap.Get(row) != (expected == triTrue) {
				t.Fatalf("%q row %d selection mismatch", tc.source, row)
			}
		}
	}
}

// TestDuplicateDictionary verifies that indices pointing at equal dictionary
// entries compare equal and that ordering comparisons stay consistent.
func TestDuplicateDictionary(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{"s": TypeString}}
	batch := &Batch{RowCount: 4, Columns: map[string]any{
		"s": &StringColumn{
			Dict:   []string{"b", "a", "b", "c"},
			Values: []int32{0, 1, 2, 3},
		},
	}}
	cases := []struct {
		source string
		want   []bool
	}{
		{"s = 'b'", []bool{true, false, true, false}},
		{"s < 'b'", []bool{false, true, false, false}},
		{"s <= 'b'", []bool{true, true, true, false}},
	}
	for _, tc := range cases {
		compiled, err := Compile(schema, tc.source)
		if err != nil {
			t.Fatalf("compile %q: %v", tc.source, err)
		}
		bitmap, err := compiled.Evaluate(batch)
		if err != nil {
			t.Fatalf("evaluate %q: %v", tc.source, err)
		}
		for row, want := range tc.want {
			if bitmap.Get(row) != want {
				t.Fatalf("%q row %d: got %v want %v", tc.source, row, bitmap.Get(row), want)
			}
		}
	}
}

// TestCompileRejections covers the compile-time rules: unknown columns,
// mismatched operand types, missing implicit conversion, and bad syntax.
func TestCompileRejections(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{
		"i": TypeInt64,
		"s": TypeString,
	}}
	cases := []struct {
		source  string
		wantErr error
	}{
		{"missing = 1", ErrUnknownColumn},
		{"i = s", ErrTypeMismatch},
		{"i = 'x'", ErrTypeMismatch},
		{"s = 1", ErrTypeMismatch},
		{"i < s", ErrTypeMismatch},
		{"i", ErrTypeMismatch},
		{"", ErrSyntax},
		{"i = 1 AND", ErrSyntax},
		{"(i = 1", ErrSyntax},
		{"i == 1", ErrSyntax},
		{"i > 1", ErrSyntax},
		{"AND i = 1", ErrSyntax},
		{"i IS NOT NULL", ErrSyntax},
		{"NOT i", ErrTypeMismatch},
		{"'unterminated = 1", ErrSyntax},
		{"i = 1 $ 2", ErrSyntax},
		{"i = 'bad\\q'", ErrSyntax},
	}
	for _, tc := range cases {
		_, err := Compile(schema, tc.source)
		if !errors.Is(err, tc.wantErr) {
			t.Fatalf("Compile(%q) got %v, want %v", tc.source, err, tc.wantErr)
		}
	}
}

// TestNullComparisons checks null operands against typed literals and
// columns, including mixed three-valued AND/OR/NOT truth tables.
func TestNullComparisons(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{"i": TypeInt64}}
	batch := &Batch{RowCount: 3, Columns: map[string]any{
		"i": &Int64Column{Dict: []int64{1, 2}, Values: []int32{0, 1, -1}},
	}}
	cases := []struct {
		source string
		want   []tri
	}{
		{"i = NULL", []tri{triUnknown, triUnknown, triUnknown}},
		{"NULL = i", []tri{triUnknown, triUnknown, triUnknown}},
		{"i = 1", []tri{triTrue, triFalse, triUnknown}},
		{"i < 2", []tri{triTrue, triFalse, triUnknown}},
		{"i <= 2", []tri{triTrue, triTrue, triUnknown}},
		{"i = 1 OR i = 2", []tri{triTrue, triTrue, triUnknown}},
		{"i = 1 AND i = 2", []tri{triFalse, triFalse, triUnknown}},
		{"NOT (i = 1)", []tri{triFalse, triTrue, triUnknown}},
	}
	for _, tc := range cases {
		compiled, err := Compile(schema, tc.source)
		if err != nil {
			t.Fatalf("compile %q: %v", tc.source, err)
		}
		got := compiled.plan.eval(batch, 3)
		assertTriEqual(t, got, tc.want, tc.source)
	}
}

// TestConcurrentReuse hammers one compiled expression from many goroutines
// against both valid and invalid batches.
func TestConcurrentReuse(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{"i": TypeInt64}}
	compiled, err := Compile(schema, "i < 10 AND NOT i IS NULL")
	if err != nil {
		t.Fatal(err)
	}
	valid := &Batch{RowCount: 4, Columns: map[string]any{
		"i": &Int64Column{Dict: []int64{1, 11, 5}, Values: []int32{0, 1, 2, -1}},
	}}
	invalid := &Batch{RowCount: 4, Columns: map[string]any{
		"i": &Int64Column{Dict: []int64{1}, Values: []int32{0, 1, 2}},
	}}
	var wg sync.WaitGroup
	for worker := 0; worker < 32; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for iteration := 0; iteration < 200; iteration++ {
				bitmap, err := compiled.Evaluate(valid)
				if err != nil {
					t.Error(err)
					return
				}
				want := []bool{true, false, true, false}
				for row, selected := range want {
					if bitmap.Get(row) != selected {
						t.Errorf("row %d = %v, want %v", row, bitmap.Get(row), selected)
						return
					}
				}
				if _, err := compiled.Evaluate(invalid); !errors.Is(err, ErrInvalidBatch) {
					t.Errorf("invalid batch got %v, want ErrInvalidBatch", err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

// TestNullLiteralAndEscapes covers literal-only predicates, quoted string
// escapes, and batches carrying columns beyond the schema.
func TestNullLiteralAndEscapes(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{"s": TypeString}}
	batch := &Batch{RowCount: 2, Columns: map[string]any{
		"s":     &StringColumn{Dict: []string{"a", "x\nz"}, Values: []int32{0, 1}},
		"extra": &Int64Column{Dict: []int64{9}, Values: []int32{0, 0}},
	}}
	cases := []struct {
		source string
		want   []bool
	}{
		{"NULL IS NULL", []bool{true, true}},
		{"s = 'a'", []bool{true, false}},
		{"s = 'x\\nz'", []bool{false, true}},
		{"s <= 'b'", []bool{true, false}},
	}
	for _, tc := range cases {
		compiled, err := Compile(schema, tc.source)
		if err != nil {
			t.Fatalf("compile %q: %v", tc.source, err)
		}
		bitmap, err := compiled.Evaluate(batch)
		if err != nil {
			t.Fatalf("evaluate %q: %v", tc.source, err)
		}
		for row, want := range tc.want {
			if bitmap.Get(row) != want {
				t.Fatalf("%q row %d: got %v want %v", tc.source, row, bitmap.Get(row), want)
			}
		}
	}
}

// TestDictIndexAtBoundary verifies the legal last dictionary index is
// accepted while the next integer beyond the dictionary is rejected.
func TestDictIndexAtBoundary(t *testing.T) {
	schema := Schema{Columns: map[string]ColumnType{"i": TypeInt64}}
	good := &Batch{RowCount: 2, Columns: map[string]any{
		"i": &Int64Column{Dict: []int64{7, 8, 9}, Values: []int32{0, 2}},
	}}
	bad := &Batch{RowCount: 2, Columns: map[string]any{
		"i": &Int64Column{Dict: []int64{7, 8, 9}, Values: []int32{0, 3}},
	}}
	compiled, err := Compile(schema, "i = 9")
	if err != nil {
		t.Fatal(err)
	}
	bitmap, err := compiled.Evaluate(good)
	if err != nil {
		t.Fatalf("legal boundary index rejected: %v", err)
	}
	if !bitmap.Get(1) || bitmap.Get(0) {
		t.Fatalf("unexpected bitmap: %v", bitmap.SelectedRows())
	}
	if _, err := compiled.Evaluate(bad); !errors.Is(err, ErrInvalidBatch) {
		t.Fatalf("out-of-range index: got %v, want ErrInvalidBatch", err)
	}
}
