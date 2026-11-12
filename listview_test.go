package dataeng

import (
	"errors"
	"math"
	"math/rand"
	"reflect"
	"testing"
)

func scalarChild(values []int64, valid []bool) *Int64Array {
	return &Int64Array{Values: values, Valid: valid}
}

func TestCompactScalar(t *testing.T) {
	view := &ListView{
		Starts:  []int64{1, -5, 0, 0, 2},
		Lengths: []int64{3, 1 << 60, 0, 2, 2},
		Valid:   []bool{true, false, true, true, true},
		Child:   scalarChild([]int64{10, 11, 12, 13, 14}, []bool{true, true, false, true, true}),
	}
	col, err := Compact(view)
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if want := []int64{0, 3, 3, 3, 5, 7}; !reflect.DeepEqual(col.Offsets, want) {
		t.Errorf("offsets = %v, want %v", col.Offsets, want)
	}
	if want := []bool{true, false, true, true, true}; !reflect.DeepEqual(col.Valid, want) {
		t.Errorf("valid = %v, want %v", col.Valid, want)
	}
	if want := []int64{1, 2, 3, 0, 1, 2, 3}; !reflect.DeepEqual(col.Positions, want) {
		t.Errorf("positions = %v, want %v", col.Positions, want)
	}
	child := col.Child.(*Int64Array)
	if want := []int64{11, 12, 13, 10, 11, 12, 13}; !reflect.DeepEqual(child.Values, want) {
		t.Errorf("values = %v, want %v", child.Values, want)
	}
	if want := []bool{true, false, true, true, true, false, true}; !reflect.DeepEqual(child.Valid, want) {
		t.Errorf("child valid = %v, want %v", child.Valid, want)
	}
}

func TestCompactNullRowOffsetsIgnored(t *testing.T) {
	view := &ListView{
		Starts:  []int64{math.MinInt64, math.MaxInt64, -1},
		Lengths: []int64{math.MaxInt64, math.MinInt64, -1},
		Valid:   []bool{false, false, false},
		Child:   scalarChild([]int64{7}, []bool{true}),
	}
	col, err := Compact(view)
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if want := []int64{0, 0, 0, 0}; !reflect.DeepEqual(col.Offsets, want) {
		t.Errorf("offsets = %v, want %v", col.Offsets, want)
	}
	if len(col.Positions) != 0 {
		t.Errorf("positions = %v, want empty", col.Positions)
	}
}

func TestCompactOutOfBounds(t *testing.T) {
	child := scalarChild([]int64{1, 2, 3}, []bool{true, true, true})
	cases := map[string]ListView{
		"negative start":  {Starts: []int64{-1}, Lengths: []int64{1}, Valid: []bool{true}, Child: child},
		"start past end":  {Starts: []int64{4}, Lengths: []int64{0}, Valid: []bool{true}, Child: child},
		"negative length": {Starts: []int64{0}, Lengths: []int64{-1}, Valid: []bool{true}, Child: child},
		"length overflow": {Starts: []int64{1}, Lengths: []int64{math.MaxInt64}, Valid: []bool{true}, Child: child},
		"range past end":  {Starts: []int64{2}, Lengths: []int64{2}, Valid: []bool{true}, Child: child},
	}
	for name, view := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Compact(&view); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

func TestValidateRangesTotalOverflow(t *testing.T) {
	valid := []bool{true, true}
	starts := []int64{0, 0}
	if _, _, err := validateRanges(starts, []int64{math.MaxInt64 - 1, 1}, valid, math.MaxInt64); err != nil {
		t.Fatalf("total MaxInt64 should be accepted: %v", err)
	}
	if _, _, err := validateRanges(starts, []int64{math.MaxInt64 - 1, 2}, valid, math.MaxInt64); err == nil {
		t.Fatal("expected total length overflow error")
	}
}

func nestedFixture() *ListView {
	grandchild := scalarChild([]int64{100, 101, 102, 103}, []bool{true, false, true, true})
	middle := &ListView{
		Starts:  []int64{0, -99, 3, 2},
		Lengths: []int64{2, 99, 1, 0},
		Valid:   []bool{true, false, true, true},
		Child:   grandchild,
	}
	return &ListView{
		Starts:  []int64{2, -7, 0},
		Lengths: []int64{2, 4, 3},
		Valid:   []bool{true, false, true},
		Child:   middle,
	}
}

func TestCompactNested(t *testing.T) {
	col, err := Compact(nestedFixture())
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if want := []int64{0, 2, 2, 5}; !reflect.DeepEqual(col.Offsets, want) {
		t.Errorf("outer offsets = %v, want %v", col.Offsets, want)
	}
	if want := []bool{true, false, true}; !reflect.DeepEqual(col.Valid, want) {
		t.Errorf("outer valid = %v, want %v", col.Valid, want)
	}
	if want := []int64{2, 3, 0, 1, 2}; !reflect.DeepEqual(col.Positions, want) {
		t.Errorf("outer positions = %v, want %v", col.Positions, want)
	}
	mid := col.Child.(*ListColumn)
	if want := []int64{0, 1, 1, 3, 3, 4}; !reflect.DeepEqual(mid.Offsets, want) {
		t.Errorf("middle offsets = %v, want %v", mid.Offsets, want)
	}
	if want := []bool{true, true, true, false, true}; !reflect.DeepEqual(mid.Valid, want) {
		t.Errorf("middle valid = %v, want %v", mid.Valid, want)
	}
	if want := []int64{3, 0, 1, 3}; !reflect.DeepEqual(mid.Positions, want) {
		t.Errorf("middle positions = %v, want %v", mid.Positions, want)
	}
	leaf := mid.Child.(*Int64Array)
	if want := []int64{103, 100, 101, 103}; !reflect.DeepEqual(leaf.Values, want) {
		t.Errorf("leaf values = %v, want %v", leaf.Values, want)
	}
	if want := []bool{true, true, false, true}; !reflect.DeepEqual(leaf.Valid, want) {
		t.Errorf("leaf valid = %v, want %v", leaf.Valid, want)
	}

	model, err := ExpandView(nestedFixture())
	if err != nil {
		t.Fatalf("ExpandView: %v", err)
	}
	got, err := ExpandColumn(col)
	if err != nil {
		t.Fatalf("ExpandColumn: %v", err)
	}
	if !reflect.DeepEqual(got, model) {
		t.Errorf("expanded column = %v, want model %v", got, model)
	}
	want := []any{
		[]any{[]any{int64(103)}, []any{}},
		nil,
		[]any{[]any{int64(100), nil}, nil, []any{int64(103)}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("expanded column = %v, want %v", got, want)
	}
}

func chainView(depth int) *ListView {
	child := any(scalarChild([]int64{1, 2, 3}, []bool{true, true, true}))
	for level := 0; level < depth; level++ {
		child = &ListView{
			Starts:  []int64{0, 1},
			Lengths: []int64{1, 1},
			Valid:   []bool{true, true},
			Child:   child,
		}
	}
	return child.(*ListView)
}

func TestDepthLimitExact(t *testing.T) {
	if _, err := Compact(chainView(MaxDepth)); err != nil {
		t.Fatalf("depth %d should be accepted: %v", MaxDepth, err)
	}
	if _, err := Compact(chainView(MaxDepth + 1)); !errors.Is(err, ErrMaxDepth) {
		t.Fatalf("depth %d: got %v, want ErrMaxDepth", MaxDepth+1, err)
	}
	if _, err := ExpandView(chainView(MaxDepth + 1)); !errors.Is(err, ErrMaxDepth) {
		t.Fatalf("ExpandView depth %d: got %v, want ErrMaxDepth", MaxDepth+1, err)
	}
}

func TestCompactEmpty(t *testing.T) {
	col, err := Compact(&ListView{
		Starts:  []int64{},
		Lengths: []int64{},
		Valid:   []bool{},
		Child:   scalarChild(nil, nil),
	})
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if want := []int64{0}; !reflect.DeepEqual(col.Offsets, want) {
		t.Errorf("offsets = %v, want %v", col.Offsets, want)
	}
	if len(col.Positions) != 0 {
		t.Errorf("positions = %v, want empty", col.Positions)
	}

	col, err = Compact(&ListView{
		Starts:  []int64{0, 0},
		Lengths: []int64{0, 0},
		Valid:   []bool{true, true},
		Child:   scalarChild(nil, nil),
	})
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if want := []int64{0, 0, 0}; !reflect.DeepEqual(col.Offsets, want) {
		t.Errorf("offsets = %v, want %v", col.Offsets, want)
	}
	got, err := ExpandColumn(col)
	if err != nil {
		t.Fatalf("ExpandColumn: %v", err)
	}
	if want := []any{[]any{}, []any{}}; !reflect.DeepEqual(got, want) {
		t.Errorf("expanded = %v, want %v (empty lists stay non-null)", got, want)
	}
}

func randomView(r *rand.Rand, depth int) *ListView {
	rows := r.Intn(7)
	v := &ListView{
		Starts:  make([]int64, rows),
		Lengths: make([]int64, rows),
		Valid:   make([]bool, rows),
	}
	var childLen int64
	if depth >= 5 || r.Intn(2) == 0 {
		n := r.Intn(10)
		child := &Int64Array{Values: make([]int64, n), Valid: make([]bool, n)}
		for i := range child.Values {
			child.Values[i] = int64(r.Intn(100))
			child.Valid[i] = r.Intn(4) != 0
		}
		v.Child = child
		childLen = int64(n)
	} else {
		child := randomView(r, depth+1)
		v.Child = child
		childLen = int64(len(child.Valid))
	}
	for i := 0; i < rows; i++ {
		if r.Intn(4) == 0 {
			v.Starts[i] = int64(r.Intn(201)) - 100
			v.Lengths[i] = int64(r.Intn(201)) - 100
			continue
		}
		v.Valid[i] = true
		var start int64
		if childLen > 0 {
			start = int64(r.Intn(int(childLen) + 1))
		}
		var length int64
		if maxLen := childLen - start; maxLen > 0 {
			length = int64(r.Intn(int(maxLen) + 1))
		}
		v.Starts[i], v.Lengths[i] = start, length
	}
	return v
}

func checkPositions(t *testing.T, inChild, outChild any, pos []int64) {
	t.Helper()
	switch in := inChild.(type) {
	case *Int64Array:
		out, ok := outChild.(*Int64Array)
		if !ok {
			t.Fatalf("child type mismatch: view %T, column %T", inChild, outChild)
		}
		if len(pos) != len(out.Values) {
			t.Fatalf("positions len %d != output child len %d", len(pos), len(out.Values))
		}
		for k, p := range pos {
			if out.Values[k] != in.Values[p] || out.Valid[k] != in.Valid[p] {
				t.Fatalf("slot %d: position %d maps to (%d, %t), output has (%d, %t)",
					k, p, in.Values[p], in.Valid[p], out.Values[k], out.Valid[k])
			}
		}
	case *ListView:
		out, ok := outChild.(*ListColumn)
		if !ok {
			t.Fatalf("child type mismatch: view %T, column %T", inChild, outChild)
		}
		inRows, err := ExpandView(in)
		if err != nil {
			t.Fatalf("ExpandView: %v", err)
		}
		outRows, err := ExpandColumn(out)
		if err != nil {
			t.Fatalf("ExpandColumn: %v", err)
		}
		if len(pos) != len(outRows) {
			t.Fatalf("positions len %d != output child rows %d", len(pos), len(outRows))
		}
		for k, p := range pos {
			if !reflect.DeepEqual(inRows[p], outRows[k]) {
				t.Fatalf("slot %d: position %d maps to %v, output has %v", k, p, inRows[p], outRows[k])
			}
		}
		checkPositions(t, in.Child, out.Child, out.Positions)
	default:
		t.Fatalf("unexpected child type %T", inChild)
	}
}

func TestCompactAgainstModel(t *testing.T) {
	for seed := int64(0); seed < 500; seed++ {
		view := randomView(rand.New(rand.NewSource(seed)), 1)
		col, err := Compact(view)
		if err != nil {
			t.Fatalf("seed %d: Compact: %v", seed, err)
		}
		model, err := ExpandView(view)
		if err != nil {
			t.Fatalf("seed %d: ExpandView: %v", seed, err)
		}
		got, err := ExpandColumn(col)
		if err != nil {
			t.Fatalf("seed %d: ExpandColumn: %v", seed, err)
		}
		if !reflect.DeepEqual(got, model) {
			t.Fatalf("seed %d: expanded column = %v, want model %v", seed, got, model)
		}
		checkPositions(t, view.Child, col.Child, col.Positions)
	}
}
