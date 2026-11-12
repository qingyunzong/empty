package dataeng

import (
	"math"
	"math/big"
	"math/rand"
	"testing"
)

// i64p returns a pointer to v, used to build non-NULL values.
func i64p(v int64) *int64 { return &v }

// referenceWindowSums is the deliberately simple row-by-row specification:
// for each row it scans every row of its partition, applies the mathematical
// integer interval test with big.Int endpoints and then the exclusion rules.
func referenceWindowSums(in Columns[string], a, b uint64, exclusion Exclusion) []Result {
	n := len(in.Keys)
	out := make([]Result, n)
	ab := new(big.Int).SetUint64(a)
	bb := new(big.Int).SetUint64(b)

	for r := 0; r < n; r++ {
		keyBig := big.NewInt(in.Keys[r])
		low := new(big.Int).Sub(keyBig, ab)
		high := new(big.Int).Add(keyBig, bb)

		sum := new(big.Int)
		var nonNull int64
		for j := 0; j < n; j++ {
			if in.Partitions[j] != in.Partitions[r] {
				continue
			}
			k := big.NewInt(in.Keys[j])
			if k.Cmp(low) < 0 || k.Cmp(high) > 0 {
				continue
			}
			switch exclusion {
			case ExcludeCurrentRow:
				if j == r {
					continue
				}
			case ExcludeGroup:
				if in.Keys[j] == in.Keys[r] {
					continue
				}
			case ExcludeTies:
				if j != r && in.Keys[j] == in.Keys[r] {
					continue
				}
			}
			if in.Values[j] != nil {
				sum.Add(sum, big.NewInt(*in.Values[j]))
				nonNull++
			}
		}

		out[r] = Result{RowID: in.RowIDs[r], NonNullCount: nonNull}
		if nonNull > 0 {
			out[r].Sum = sum
		}
	}
	return out
}

func resultsEqual(got, want []Result) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i].RowID != want[i].RowID || got[i].NonNullCount != want[i].NonNullCount {
			return false
		}
		if want[i].Sum == nil {
			if got[i].Sum != nil {
				return false
			}
			continue
		}
		if got[i].Sum == nil || got[i].Sum.Cmp(want[i].Sum) != 0 {
			return false
		}
	}
	return true
}

// TestWindowSumsAgainstReference fuzzes the indexed operator against the
// straightforward per-row scan, including repeated keys, NULL values,
// multiple partitions and overflowing offsets and sums.
func TestWindowSumsAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	exclusions := []Exclusion{ExcludeNone, ExcludeCurrentRow, ExcludeGroup, ExcludeTies}
	offsets := []uint64{0, 1, 2, 3, 7, 100, uint64(math.MaxInt64), uint64(math.MaxInt64) + 5, math.MaxUint64}

	for iter := 0; iter < 300; iter++ {
		in := randomColumns(rng)
		a := offsets[rng.Intn(len(offsets))]
		b := offsets[rng.Intn(len(offsets))]
		ex := exclusions[rng.Intn(len(exclusions))]

		got, err := WindowSums(in, a, b, ex)
		if err != nil {
			t.Fatalf("iter %d: unexpected error: %v", iter, err)
		}
		want := referenceWindowSums(in, a, b, ex)
		if !resultsEqual(got, want) {
			t.Fatalf("iter %d mismatch a=%d b=%d ex=%d\n got=%v\nwant=%v", iter, a, b, ex, got, want)
		}
	}
}

func randomColumns(rng *rand.Rand) Columns[string] {
	partCount := 1 + rng.Intn(4)
	type row struct {
		part string
		key  int64
		id   int64
		val  *int64
	}
	var rows []row
	var id int64 = 1

	for p := 0; p < partCount; p++ {
		partName := string(rune('A' + p))
		rowCount := rng.Intn(40)
		// Small key domain forces duplicate keys; include the int64 edges.
		keyDomain := []int64{math.MinInt64, -10, -3, -1, 0, 1, 3, 10, math.MaxInt64}
		for k := 0; k < rowCount; k++ {
			key := keyDomain[rng.Intn(len(keyDomain))]
			var v *int64
			switch rng.Intn(3) {
			case 0:
				v = nil
			case 1:
				v = i64p(int64(rng.Intn(21)) - 10)
			case 2:
				v = i64p(math.MaxInt64 - int64(rng.Intn(3)))
			}
			rows = append(rows, row{partName, key, id, v})
			id++
		}
	}

	// Sort by (partition, key, row ID) to satisfy the operator contract.
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0; j-- {
			x, y := rows[j-1], rows[j]
			less := x.part < y.part ||
				(x.part == y.part && (x.key < y.key || (x.key == y.key && x.id < y.id)))
			if !less {
				rows[j-1], rows[j] = y, x
			}
		}
	}

	in := Columns[string]{}
	for _, r := range rows {
		in.Partitions = append(in.Partitions, r.part)
		in.Keys = append(in.Keys, r.key)
		in.RowIDs = append(in.RowIDs, r.id)
		in.Values = append(in.Values, r.val)
	}
	return in
}

// TestPartitionBoundary checks that a frame never reaches across partitions,
// including when keys and offsets overlap the neighbour partition.
func TestPartitionBoundary(t *testing.T) {
	in := Columns[string]{
		Partitions: []string{"p", "p", "q", "q"},
		Keys:       []int64{5, 100, 5, 100},
		RowIDs:     []int64{1, 2, 3, 4},
		Values:     []*int64{i64p(7), i64p(9), i64p(11), i64p(13)},
	}
	got, err := WindowSums(in, 1000, 1000, ExcludeNone)
	if err != nil {
		t.Fatal(err)
	}
	want := []Result{
		{RowID: 1, Sum: big.NewInt(16), NonNullCount: 2},
		{RowID: 2, Sum: big.NewInt(16), NonNullCount: 2},
		{RowID: 3, Sum: big.NewInt(24), NonNullCount: 2},
		{RowID: 4, Sum: big.NewInt(24), NonNullCount: 2},
	}
	if !resultsEqual(got, want) {
		t.Fatalf("partition boundary:\n got=%v\nwant=%v", got, want)
	}
}

// TestDuplicateKeysExclusions exercises all exclusion modes over a tie group.
func TestDuplicateKeysExclusions(t *testing.T) {
	// Keys 10 (two rows, values 3 / 4) inside a wider frame containing key 9.
	in := Columns[string]{
		Partitions: []string{"p", "p", "p"},
		Keys:       []int64{9, 10, 10},
		RowIDs:     []int64{1, 2, 3},
		Values:     []*int64{i64p(2), i64p(3), i64p(4)},
	}
	tests := []struct {
		name string
		ex   Exclusion
		want []Result
	}{
		{
			name: "none",
			ex:   ExcludeNone,
			want: []Result{
				{RowID: 1, Sum: big.NewInt(9), NonNullCount: 3},
				{RowID: 2, Sum: big.NewInt(9), NonNullCount: 3},
				{RowID: 3, Sum: big.NewInt(9), NonNullCount: 3},
			},
		},
		{
			name: "current row",
			ex:   ExcludeCurrentRow,
			want: []Result{
				{RowID: 1, Sum: big.NewInt(7), NonNullCount: 2},
				{RowID: 2, Sum: big.NewInt(6), NonNullCount: 2},
				{RowID: 3, Sum: big.NewInt(5), NonNullCount: 2},
			},
		},
		{
			name: "group",
			ex:   ExcludeGroup,
			want: []Result{
				{RowID: 1, Sum: big.NewInt(7), NonNullCount: 2},
				{RowID: 2, Sum: big.NewInt(2), NonNullCount: 1},
				{RowID: 3, Sum: big.NewInt(2), NonNullCount: 1},
			},
		},
		{
			name: "ties",
			ex:   ExcludeTies,
			want: []Result{
				{RowID: 1, Sum: big.NewInt(9), NonNullCount: 3},
				{RowID: 2, Sum: big.NewInt(5), NonNullCount: 2},
				{RowID: 3, Sum: big.NewInt(6), NonNullCount: 2}, // 2 + self(4)
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := WindowSums(in, 1, 1, tc.ex)
			if err != nil {
				t.Fatal(err)
			}
			if !resultsEqual(got, tc.want) {
				t.Fatalf("got=%v\nwant=%v", got, tc.want)
			}
		})
	}
}

// TestEmptyAndNullFrames verifies that empty and all-NULL frames both give a
// NULL sum with a zero non-NULL count.
func TestEmptyAndNullFrames(t *testing.T) {
	in := Columns[string]{
		Partitions: []string{"p", "p", "p"},
		Keys:       []int64{1, 2, 3},
		RowIDs:     []int64{1, 2, 3},
		Values:     []*int64{nil, i64p(5), nil},
	}
	got, err := WindowSums(in, 0, 0, ExcludeNone)
	if err != nil {
		t.Fatal(err)
	}
	want := []Result{
		{RowID: 1, Sum: nil, NonNullCount: 0}, // only the NULL row itself
		{RowID: 2, Sum: big.NewInt(5), NonNullCount: 1},
		{RowID: 3, Sum: nil, NonNullCount: 0},
	}
	if !resultsEqual(got, want) {
		t.Fatalf("got=%v\nwant=%v", got, want)
	}

	// An exclusion that removes every included row yields an empty frame.
	only := Columns[string]{
		Partitions: []string{"p"},
		Keys:       []int64{42},
		RowIDs:     []int64{9},
		Values:     []*int64{nil},
	}
	got, err = WindowSums(only, 10, 10, ExcludeGroup)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Sum != nil || got[0].NonNullCount != 0 || got[0].RowID != 9 {
		t.Fatalf("empty frame result wrong: %+v", got[0])
	}
}

// TestOverflowBoundaries covers endpoints computed outside the int64 range
// and sums that cannot fit in an int64.
func TestOverflowBoundaries(t *testing.T) {
	in := Columns[string]{
		Partitions: []string{"p", "p", "p", "p"},
		Keys:       []int64{math.MinInt64, math.MinInt64 + 1, math.MaxInt64 - 1, math.MaxInt64},
		RowIDs:     []int64{1, 2, 3, 4},
		Values:     []*int64{i64p(math.MaxInt64), i64p(math.MaxInt64), i64p(math.MinInt64), i64p(math.MinInt64)},
	}
	got, err := WindowSums(in, math.MaxUint64, math.MaxUint64, ExcludeNone)
	if err != nil {
		t.Fatal(err)
	}

	// Every frame spans the whole partition: 2*MaxInt64 + 2*MinInt64 = -2.
	total := new(big.Int).Add(
		new(big.Int).Mul(big.NewInt(2), big.NewInt(math.MaxInt64)),
		new(big.Int).Mul(big.NewInt(2), big.NewInt(math.MinInt64)),
	)
	if total.Cmp(big.NewInt(-2)) != 0 {
		t.Fatalf("test setup wrong: %v", total)
	}
	for _, r := range got {
		if r.NonNullCount != 4 || r.Sum == nil || r.Sum.Cmp(total) != 0 {
			t.Fatalf("overflow row %d: got sum=%v cnt=%d, want %v / 4", r.RowID, r.Sum, r.NonNullCount, total)
		}
	}

	// A lower endpoint below MinInt64 saturates to the edge and includes it.
	edge := Columns[string]{
		Partitions: []string{"p", "p"},
		Keys:       []int64{math.MinInt64, math.MinInt64 + 2},
		RowIDs:     []int64{7, 8},
		Values:     []*int64{i64p(10), i64p(20)},
	}
	got, err = WindowSums(edge, math.MaxUint64, 0, ExcludeNone)
	if err != nil {
		t.Fatal(err)
	}
	want := []Result{
		{RowID: 7, Sum: big.NewInt(10), NonNullCount: 1},
		{RowID: 8, Sum: big.NewInt(30), NonNullCount: 2},
	}
	if !resultsEqual(got, want) {
		t.Fatalf("lower edge:\n got=%v\nwant=%v", got, want)
	}
}

// TestValidationErrors makes malformed inputs fail loudly instead of producing
// silently wrong frames.
func TestValidationErrors(t *testing.T) {
	base := Columns[string]{
		Partitions: []string{"p", "p"},
		Keys:       []int64{1, 2},
		RowIDs:     []int64{1, 2},
		Values:     []*int64{i64p(1), i64p(2)},
	}

	if _, err := WindowSums(Columns[string]{Keys: base.Keys}, 0, 0, ExcludeNone); err == nil {
		t.Fatal("expected length mismatch error")
	}

	unsorted := base
	unsorted.Keys = []int64{2, 1}
	if _, err := WindowSums(unsorted, 0, 0, ExcludeNone); err == nil {
		t.Fatal("expected ordering error")
	}

	dupID := base
	dupID.RowIDs = []int64{1, 1}
	if _, err := WindowSums(dupID, 0, 0, ExcludeNone); err == nil {
		t.Fatal("expected duplicate row ID error")
	}

	// Partition blocks must be contiguous.
	split := Columns[string]{
		Partitions: []string{"p", "q", "p"},
		Keys:       []int64{1, 1, 2},
		RowIDs:     []int64{1, 2, 3},
		Values:     []*int64{i64p(1), i64p(2), i64p(3)},
	}
	if _, err := WindowSums(split, 0, 0, ExcludeNone); err == nil {
		t.Fatal("expected non-contiguous partition error")
	}

	if _, err := WindowSums(base, 0, 0, Exclusion(99)); err == nil {
		t.Fatal("expected invalid exclusion error")
	}
}

// TestEmptyInput covers the degenerate relation and confirms output order.
func TestEmptyInput(t *testing.T) {
	got, err := WindowSums(Columns[string]{}, 1, 1, ExcludeTies)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty result, got %v", got)
	}
}
