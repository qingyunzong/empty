package dataeng

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func intRows(n int) []Tuple {
	rows := make([]Tuple, n)
	for i := range rows {
		rows[i] = Tuple{i}
	}
	return rows
}

func TestPlannerPartitionsEveryRowOnce(t *testing.T) {
	const n = 100
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	src, err := NewMemorySource(cols, intRows(n))
	if err != nil {
		t.Fatal(err)
	}
	planner := Planner{Source: src, Options: Options{ChunkCount: 5}}
	plan, err := planner.Plan(context.Background(), "items")
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := len(plan.Chunks); got != 5 {
		t.Fatalf("chunks = %d, want 5", got)
	}
	if src.begins != 1 {
		t.Fatalf("BeginSnapshot calls = %d, want 1", src.begins)
	}
	cs, ok := plan.Snapshot.(*countedSnapshot)
	if !ok || cs.MemorySnapshot != src.lastSnp {
		t.Fatalf("plan did not keep the sampled snapshot")
	}

	for i := 0; i < n; i++ {
		count := 0
		for _, chunk := range plan.Chunks {
			in, err := chunk.Contains(Tuple{i}, cols)
			if err != nil {
				t.Fatal(err)
			}
			if in {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("row %d belongs to %d chunks", i, count)
		}
	}

	if err := plan.Close(); err != nil {
		t.Fatal(err)
	}
	if src.closes != 1 {
		t.Fatalf("snapshot closes = %d, want 1", src.closes)
	}
	if err := plan.Close(); err != nil {
		t.Fatal(err)
	}
	if src.closes != 1 {
		t.Fatalf("second Close changed close count to %d", src.closes)
	}
	if _, err := plan.Snapshot.CountRows(context.Background(), "items"); !errors.Is(err, ErrSnapshotClosed) {
		t.Fatalf("query after close: %v", err)
	}
}

func TestNoPrimaryKeyIsAnExplicitError(t *testing.T) {
	src, err := NewMemorySource(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	planner := Planner{Source: src}
	plan, err := planner.Plan(context.Background(), "logs")
	if plan != nil {
		t.Fatalf("got a plan for a table without a primary key: %v", plan.Chunks)
	}
	if !errors.Is(err, ErrNoPrimaryKey) {
		t.Fatalf("error = %v, want ErrNoPrimaryKey", err)
	}
	var noPK *NoPrimaryKeyError
	if !errors.As(err, &noPK) || noPK.Table != "logs" {
		t.Fatalf("error = %v, want NoPrimaryKeyError{logs}", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "offset") {
		t.Fatalf("error should not suggest offset fallback: %v", err)
	}
	if src.closes != 1 {
		t.Fatalf("failed planning did not close snapshot: %d", src.closes)
	}
}

func TestCompositeNullKeysPartition(t *testing.T) {
	cols := []KeyColumn{
		{Name: "a", Kind: KindInt},
		{Name: "b", Kind: KindString, Nulls: NullsFirst, Collation: foldCollation()},
	}
	rows := []Tuple{
		{1, nil}, {1, "A"}, {1, "a"}, {1, "B"},
		{2, nil}, {2, "z"},
		{nil, nil}, {nil, "a"},
	}
	src, err := NewMemorySource(cols, rows)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildPlan(context.Background(), src.lastOrNew(t), "composite", Options{ChunkCount: 3})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		count := 0
		for _, chunk := range plan.Chunks {
			in, err := chunk.Contains(row, cols)
			if err != nil {
				t.Fatal(err)
			}
			if in {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("key %s belongs to %d chunks", FormatTuple(row), count)
		}
	}
}

func (s *MemorySource) lastOrNew(t *testing.T) *MemorySnapshot {
	t.Helper()
	snap, err := NewMemorySnapshot(s.cols, s.rows)
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

type fakeKeySource struct {
	cols    []KeyColumn
	total   int64
	sampled []Tuple
}

func (s *fakeKeySource) PrimaryKey(context.Context, string) ([]KeyColumn, error) {
	return append([]KeyColumn(nil), s.cols...), nil
}

func (s *fakeKeySource) CountRows(context.Context, string) (int64, error) {
	return s.total, nil
}

func (s *fakeKeySource) SampleKeys(context.Context, string, []KeyColumn, int) ([]Tuple, error) {
	return s.sampled, nil
}

func TestBoundarySamplingSortsDeduplicatesAndCaps(t *testing.T) {
	src := &fakeKeySource{
		cols:    []KeyColumn{{Name: "id", Kind: KindInt}},
		total:   10,
		sampled: []Tuple{{4}, {1}, {2}, {1}, {3}, {9}},
	}
	plan, err := BuildPlan(context.Background(), src, "t", Options{ChunkCount: 3})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(plan.Boundaries); got != 2 {
		t.Fatalf("boundaries = %d (%v), want 2", got, plan.Boundaries)
	}
	cmp, err := CompareTuples(plan.Boundaries[0], plan.Boundaries[1], plan.KeyColumns)
	if err != nil || cmp >= 0 {
		t.Fatalf("boundaries not strictly ordered: %v, %v", plan.Boundaries, err)
	}
	if err := plan.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyAndSingleRowTables(t *testing.T) {
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	for _, tc := range []struct {
		n    int
		want int
	}{
		{0, 1},
		{1, 1},
	} {
		src, err := NewMemorySource(cols, intRows(tc.n))
		if err != nil {
			t.Fatal(err)
		}
		plan, err := BuildPlan(context.Background(), src.lastOrNew(t), "t", Options{ChunkCount: 8})
		if err != nil {
			t.Fatal(err)
		}
		if got := len(plan.Chunks); got != tc.want {
			t.Fatalf("%d rows produced %d chunks, want %d", tc.n, got, tc.want)
		}
		if plan.Chunks[0].Lower.IsUnbounded() == false || plan.Chunks[0].Upper.IsUnbounded() == false {
			t.Fatalf("%d rows: expected one fully unbounded chunk: %s", tc.n, plan.Chunks[0])
		}
	}
}

func TestRowsPerChunkRequiresKnownCount(t *testing.T) {
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	src := &fakeKeySource{cols: cols, total: -1}
	_, err := BuildPlan(context.Background(), src, "t", Options{RowsPerChunk: 100})
	if !errors.Is(err, ErrUnknownRowCount) {
		t.Fatalf("error = %v, want ErrUnknownRowCount", err)
	}

	src.total = 25
	src.sampled = []Tuple{{9}, {18}}
	plan, err := BuildPlan(context.Background(), src, "t", Options{RowsPerChunk: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(plan.Chunks); got != 3 {
		t.Fatalf("chunks = %d, want 3", got)
	}
}

func TestQueriesHaveNoOffsetOrLimit(t *testing.T) {
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	src, err := NewMemorySource(cols, intRows(20))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildPlan(context.Background(), src.lastOrNew(t), "t", Options{ChunkCount: 3})
	if err != nil {
		t.Fatal(err)
	}
	queries, err := plan.Queries(SQLite, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != len(plan.Chunks) {
		t.Fatalf("queries = %d, chunks = %d", len(queries), len(plan.Chunks))
	}
	for i, q := range queries {
		upper := strings.ToUpper(q.SQL)
		if strings.Contains(upper, "OFFSET") || strings.Contains(upper, "LIMIT") {
			t.Fatalf("query %d uses unstable pagination: %s", i, q.SQL)
		}
		if i > 0 && !strings.Contains(q.SQL, "WHERE") {
			t.Fatalf("query %d has no key predicate: %s", i, q.SQL)
		}
	}
}

func TestValidateChunksRejectsGapAndOverlap(t *testing.T) {
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	gap := []Chunk{
		{Table: "t", Index: 0, Lower: Unbounded(), Upper: ExclusiveKey(Tuple{2})},
		{Table: "t", Index: 1, Lower: InclusiveKey(Tuple{3}), Upper: Unbounded()},
	}
	if err := ValidateChunks(gap, cols); !errors.Is(err, ErrInvalidPlan) {
		t.Fatalf("gap error = %v", err)
	}
	overlap := []Chunk{
		{Table: "t", Index: 0, Lower: Unbounded(), Upper: ExclusiveKey(Tuple{2})},
		{Table: "t", Index: 1, Lower: InclusiveKey(Tuple{1}), Upper: Unbounded()},
	}
	if err := ValidateChunks(overlap, cols); !errors.Is(err, ErrInvalidPlan) {
		t.Fatalf("overlap error = %v", err)
	}
	if err := ValidateChunks(gap, nil); err == nil {
		t.Fatal("expected an error for missing key columns")
	}
}

func ExamplePlan() {
	cols := []KeyColumn{{Name: "id", Kind: KindInt}}
	src, _ := NewMemorySource(cols, intRows(6))
	snap, _ := NewMemorySnapshot(src.cols, src.rows)
	plan, _ := BuildPlan(context.Background(), snap, "items", Options{ChunkCount: 3})
	for _, chunk := range plan.Chunks {
		fmt.Println(chunk.String())
	}
	// Output:
	// items (-inf, (2))
	// items [(2), (4))
	// items [(4), +inf)
}
