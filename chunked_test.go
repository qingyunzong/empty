package dataeng_test

import (
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"testing"

	dataeng "example.org/dataeng/q0184"
)

// refStore 用一个完整的行主序数组充当参考实现，同时实现 ChunkReader。
type refStore struct {
	nd         int
	shape      []int64
	chunkShape []int64
	data       []int64
	badChunks  map[string]bool
	calls      int
}

func newRefStore(shape, chunkShape []int64, badChunks map[string]bool) *refStore {
	s := &refStore{
		nd:         len(shape),
		shape:      append([]int64(nil), shape...),
		chunkShape: append([]int64(nil), chunkShape...),
		badChunks:  badChunks,
	}
	total := int64(1)
	for _, extent := range shape {
		total *= extent
	}
	s.data = make([]int64, total)
	if total > 0 {
		walk(shape, func(coord []int64) {
			s.data[s.offset(coord)] = s.offset(coord) + 1
		})
	}
	return s
}

func (s *refStore) offset(coord []int64) int64 {
	off := int64(0)
	for d := range coord {
		stride := int64(1)
		for k := d + 1; k < s.nd; k++ {
			stride *= s.shape[k]
		}
		off += coord[d] * stride
	}
	return off
}

func (s *refStore) ReadChunk(chunkCoord []int64) ([]int64, error) {
	s.calls++
	if s.badChunks[fmt.Sprint(chunkCoord)] {
		// 故意返回错误长度：合法块至少含一个元素。
		return []int64{-1}, nil
	}
	edge := make([]int64, s.nd)
	for d := range edge {
		edge[d] = s.shape[d] - chunkCoord[d]*s.chunkShape[d]
	}
	out := make([]int64, 0)
	local := make([]int64, s.nd)
	var rec func(d int)
	rec = func(d int) {
		if d == s.nd {
			global := make([]int64, s.nd)
			for i := range global {
				global[i] = chunkCoord[i]*s.chunkShape[i] + local[i]
			}
			out = append(out, s.data[s.offset(global)])
			return
		}
		for i := int64(0); i < edge[d]; i++ {
			local[d] = i
			rec(d + 1)
		}
	}
	rec(0)
	return out, nil
}

func walk(shape []int64, fn func(coord []int64)) {
	coord := make([]int64, len(shape))
	var rec func(d int)
	rec = func(d int) {
		if d == len(shape) {
			fn(append([]int64(nil), coord...))
			return
		}
		for i := int64(0); i < shape[d]; i++ {
			coord[d] = i
			rec(d + 1)
		}
	}
	rec(0)
}

func queryCoords(q dataeng.DimQuery) []int64 {
	out := make([]int64, q.Count)
	for i := range out {
		out[i] = q.Start + int64(i)*q.Step
	}
	return out
}

// expectedValues 按查询行主序枚举坐标，用完整数组参考计算期望值。
func expectedValues(store *refStore, queries []dataeng.DimQuery) []int64 {
	dimCoords := make([][]int64, len(queries))
	for i, q := range queries {
		dimCoords[i] = queryCoords(q)
	}
	total := int64(1)
	for _, c := range dimCoords {
		total *= int64(len(c))
	}
	out := make([]int64, 0, total)
	coord := make([]int64, len(queries))
	var rec func(d int)
	rec = func(d int) {
		if d == len(queries) {
			out = append(out, store.data[store.offset(coord)])
			return
		}
		for _, v := range dimCoords[d] {
			coord[d] = v
			rec(d + 1)
		}
	}
	rec(0)
	return out
}

func sliceEqual(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sliceLess(a, b []int64) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func coordEqual(a, b [][]int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !sliceEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

func TestZeroCountSkipsStartValidationAndReads(t *testing.T) {
	calls := 0
	reader := dataeng.ChunkReaderFunc(func(chunkCoord []int64) ([]int64, error) {
		calls++
		return nil, fmt.Errorf("reader must not be called")
	})

	cases := []struct {
		name       string
		shape      []int64
		chunkShape []int64
		queries    []dataeng.DimQuery
	}{
		{
			name:       "1d start way out of bounds but zero count",
			shape:      []int64{5},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 99, Count: 0, Step: 1}},
		},
		{
			name:       "2d negative out of bounds start ignored",
			shape:      []int64{3, 4},
			chunkShape: []int64{2, 2},
			queries: []dataeng.DimQuery{
				{Start: 0, Count: 2, Step: 1},
				{Start: -5, Count: 0, Step: -2},
			},
		},
		{
			name:       "zero extent dimension",
			shape:      []int64{0, 3},
			chunkShape: []int64{1, 2},
			queries: []dataeng.DimQuery{
				{Start: 7, Count: 0, Step: 1},
				{Start: 0, Count: 3, Step: 1},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls = 0
			res, err := dataeng.Read(tc.shape, tc.chunkShape, tc.queries, reader)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if calls != 0 {
				t.Fatalf("reader called %d times for zero-count query", calls)
			}
			if len(res.Values) != 0 || len(res.Visits) != 0 {
				t.Fatalf("expected empty result, got %+v", res)
			}
		})
	}
}

func TestCrossChunkNegativeStep1D(t *testing.T) {
	shape := []int64{7}
	chunkShape := []int64{3}
	store := newRefStore(shape, chunkShape, nil)
	queries := []dataeng.DimQuery{{Start: 6, Count: 7, Step: -1}}

	res, err := dataeng.Read(shape, chunkShape, queries, store)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if got, want := res.Values, expectedValues(store, queries); !sliceEqual(got, want) {
		t.Fatalf("values mismatch:\n got %v\nwant %v", got, want)
	}
	// 坐标 6..0 跨越块 0、1、2，每块恰好读取一次。
	if store.calls != 3 || len(res.Visits) != 3 {
		t.Fatalf("expected 3 chunk reads, got calls=%d visits=%d", store.calls, len(res.Visits))
	}
	wantVisits := []struct {
		chunk  int64
		coords [][]int64
	}{
		{0, [][]int64{{2}, {1}, {0}}},
		{1, [][]int64{{5}, {4}, {3}}},
		{2, [][]int64{{6}}},
	}
	for i, want := range wantVisits {
		if res.Visits[i].ChunkCoord[0] != want.chunk {
			t.Fatalf("visit %d chunk = %d, want %d", i, res.Visits[i].ChunkCoord[0], want.chunk)
		}
		if !coordEqual(res.Visits[i].Coords, want.coords) {
			t.Fatalf("visit %d coords = %v, want %v", i, res.Visits[i].Coords, want.coords)
		}
	}
}

func TestCrossChunkNegativeStep2D(t *testing.T) {
	shape := []int64{4, 5}
	chunkShape := []int64{2, 3}
	store := newRefStore(shape, chunkShape, nil)
	queries := []dataeng.DimQuery{
		{Start: 3, Count: 4, Step: -1},
		{Start: 4, Count: 5, Step: -1},
	}

	res, err := dataeng.Read(shape, chunkShape, queries, store)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if got, want := res.Values, expectedValues(store, queries); !sliceEqual(got, want) {
		t.Fatalf("values mismatch:\n got %v\nwant %v", got, want)
	}
	// 2x2 的块网格，每块读到且只读一次。
	if store.calls != 4 || len(res.Visits) != 4 {
		t.Fatalf("expected 4 chunk reads, got calls=%d visits=%d", store.calls, len(res.Visits))
	}
	totalCoords := 0
	for _, visit := range res.Visits {
		totalCoords += len(visit.Coords)
		for _, coord := range visit.Coords {
			for d := range coord {
				if coord[d] < 0 || coord[d] >= shape[d] {
					t.Fatalf("visit coord %v out of shape %v", coord, shape)
				}
			}
		}
	}
	if totalCoords != 20 {
		t.Fatalf("expected 20 visited coords, got %d", totalCoords)
	}
}

func TestBadEdgeAndInteriorChunks(t *testing.T) {
	t.Run("edge chunk wrong length", func(t *testing.T) {
		shape := []int64{5}
		chunkShape := []int64{3}
		// 块 1 是边块，实际只含 2 个元素；读取器故意返回 1 个。
		store := newRefStore(shape, chunkShape, map[string]bool{"[1]": true})
		_, err := dataeng.Read(shape, chunkShape,
			[]dataeng.DimQuery{{Start: 0, Count: 5, Step: 1}}, store)
		if !errors.Is(err, dataeng.ErrBadChunk) {
			t.Fatalf("want ErrBadChunk, got %v", err)
		}
	})

	t.Run("interior chunk wrong length", func(t *testing.T) {
		shape := []int64{9}
		chunkShape := []int64{3}
		store := newRefStore(shape, chunkShape, map[string]bool{"[1]": true})
		_, err := dataeng.Read(shape, chunkShape,
			[]dataeng.DimQuery{{Start: 0, Count: 9, Step: 1}}, store)
		if !errors.Is(err, dataeng.ErrBadChunk) {
			t.Fatalf("want ErrBadChunk, got %v", err)
		}
	})

	t.Run("edge chunk correct length accepted", func(t *testing.T) {
		shape := []int64{5}
		chunkShape := []int64{3}
		store := newRefStore(shape, chunkShape, nil)
		res, err := dataeng.Read(shape, chunkShape,
			[]dataeng.DimQuery{{Start: 0, Count: 5, Step: 1}}, store)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res.Values) != 5 {
			t.Fatalf("want 5 values, got %d", len(res.Values))
		}
	})
}

func TestValidationHappensBeforeAnyRead(t *testing.T) {
	calls := 0
	countingReader := dataeng.ChunkReaderFunc(func(chunkCoord []int64) ([]int64, error) {
		calls++
		return []int64{0}, nil
	})

	cases := []struct {
		name       string
		shape      []int64
		chunkShape []int64
		queries    []dataeng.DimQuery
		reader     dataeng.ChunkReader
		want       error
	}{
		{
			name:       "positive step out of bounds",
			shape:      []int64{3},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 2, Count: 2, Step: 1}},
			reader:     countingReader,
			want:       dataeng.ErrOutOfBounds,
		},
		{
			name:       "negative step out of bounds",
			shape:      []int64{3},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 0, Count: 2, Step: -1}},
			reader:     countingReader,
			want:       dataeng.ErrOutOfBounds,
		},
		{
			name:       "zero step",
			shape:      []int64{3},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 0, Count: 2, Step: 0}},
			reader:     countingReader,
			want:       dataeng.ErrZeroStep,
		},
		{
			name:       "negative count",
			shape:      []int64{3},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 0, Count: -1, Step: 1}},
			reader:     countingReader,
			want:       dataeng.ErrNegativeCount,
		},
		{
			name:       "negative shape extent",
			shape:      []int64{-1},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 0, Count: 1, Step: 1}},
			reader:     countingReader,
			want:       dataeng.ErrBadShape,
		},
		{
			name:       "non-positive chunk shape",
			shape:      []int64{3},
			chunkShape: []int64{0},
			queries:    []dataeng.DimQuery{{Start: 0, Count: 1, Step: 1}},
			reader:     countingReader,
			want:       dataeng.ErrBadChunkShape,
		},
		{
			name:       "dimension mismatch",
			shape:      []int64{3, 3},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 0, Count: 1, Step: 1}},
			reader:     countingReader,
			want:       dataeng.ErrBadDimensions,
		},
		{
			name:       "too many dimensions",
			shape:      make([]int64, 9),
			chunkShape: make([]int64, 9),
			queries: func() []dataeng.DimQuery {
				qs := make([]dataeng.DimQuery, 9)
				for i := range qs {
					qs[i] = dataeng.DimQuery{Count: 1, Step: 1}
				}
				return qs
			}(),
			reader: countingReader,
			want:   dataeng.ErrBadDimensions,
		},
		{
			name:       "nil reader",
			shape:      []int64{3},
			chunkShape: []int64{2},
			queries:    []dataeng.DimQuery{{Start: 0, Count: 1, Step: 1}},
			reader:     nil,
			want:       dataeng.ErrNilReader,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls = 0
			_, err := dataeng.Read(tc.shape, tc.chunkShape, tc.queries, tc.reader)
			if !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
			if calls != 0 {
				t.Fatalf("reader called %d times before validation completed", calls)
			}
		})
	}
}

func TestOverflowBeforeReads(t *testing.T) {
	calls := 0
	reader := dataeng.ChunkReaderFunc(func(chunkCoord []int64) ([]int64, error) {
		calls++
		return nil, fmt.Errorf("reader must not be called")
	})
	big := int64(1) << 40

	cases := []struct {
		name       string
		shape      []int64
		chunkShape []int64
		queries    []dataeng.DimQuery
	}{
		{
			name:       "product of counts overflows int64",
			shape:      []int64{big, big},
			chunkShape: []int64{4, 4},
			queries: []dataeng.DimQuery{
				{Start: 0, Count: big, Step: 1},
				{Start: 0, Count: big, Step: 1},
			},
		},
		{
			name:       "negative step span overflows",
			shape:      []int64{big},
			chunkShape: []int64{4},
			queries:    []dataeng.DimQuery{{Start: 0, Count: big, Step: math.MinInt64}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls = 0
			_, err := dataeng.Read(tc.shape, tc.chunkShape, tc.queries, reader)
			if !errors.Is(err, dataeng.ErrOverflow) {
				t.Fatalf("want ErrOverflow, got %v", err)
			}
			if calls != 0 {
				t.Fatalf("reader called %d times before overflow was reported", calls)
			}
		})
	}
}

func TestEmptyShape(t *testing.T) {
	calls := 0
	reader := dataeng.ChunkReaderFunc(func(chunkCoord []int64) ([]int64, error) {
		calls++
		return nil, nil
	})

	// 形状含零维：任何非零 count 都会越界，零 count 直接返回空结果。
	if _, err := dataeng.Read([]int64{0, 3}, []int64{1, 2},
		[]dataeng.DimQuery{
			{Start: 0, Count: 1, Step: 1},
			{Start: 0, Count: 3, Step: 1},
		}, reader); !errors.Is(err, dataeng.ErrOutOfBounds) {
		t.Fatalf("want ErrOutOfBounds on empty dimension, got %v", err)
	}

	res, err := dataeng.Read([]int64{0, 3}, []int64{1, 2},
		[]dataeng.DimQuery{
			{Start: 100, Count: 0, Step: 1},
			{Start: 0, Count: 3, Step: 1},
		}, reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Values) != 0 || calls != 0 {
		t.Fatalf("expected no values and no reads, got values=%d calls=%d", len(res.Values), calls)
	}
}

func TestEightDims(t *testing.T) {
	nd := 8
	shape := []int64{2, 2, 3, 2, 2, 3, 2, 2}
	chunkShape := []int64{2, 1, 2, 2, 1, 3, 2, 1}
	store := newRefStore(shape, chunkShape, nil)
	queries := make([]dataeng.DimQuery, nd)
	for d := range queries {
		queries[d] = dataeng.DimQuery{Start: shape[d] - 1, Count: shape[d], Step: -1}
	}

	res, err := dataeng.Read(shape, chunkShape, queries, store)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if got, want := res.Values, expectedValues(store, queries); !sliceEqual(got, want) {
		t.Fatalf("8D values mismatch (len got=%d want=%d)", len(got), len(want))
	}

	// 每块只读一次，且各块汇报的坐标数量之和等于取数总数。
	chunkGrids := int64(1)
	for d := range shape {
		chunkGrids *= (shape[d] + chunkShape[d] - 1) / chunkShape[d]
	}
	if int64(store.calls) != chunkGrids || int64(len(res.Visits)) != chunkGrids {
		t.Fatalf("want %d chunk reads, got calls=%d visits=%d", chunkGrids, store.calls, len(res.Visits))
	}
	visited := 0
	for _, visit := range res.Visits {
		visited += len(visit.Coords)
	}
	if int64(visited) != store.data[len(store.data)-1] {
		t.Fatalf("visited coords = %d, want %d", visited, store.data[len(store.data)-1])
	}
}

func TestRandomAgainstFullArrayReference(t *testing.T) {
	rng := rand.New(rand.NewPCG(20261112, 42))

	for iter := 0; iter < 40; iter++ {
		nd := 1 + rng.IntN(8)
		shape := make([]int64, nd)
		chunkShape := make([]int64, nd)
		for d := range shape {
			shape[d] = int64(rng.IntN(6)) // 含 0，覆盖空数组与边块
			chunkShape[d] = 1 + int64(rng.IntN(4))
		}

		store := newRefStore(shape, chunkShape, nil)
		queries := make([]dataeng.DimQuery, nd)
		for d := range queries {
			if shape[d] == 0 {
				// 空维上只能零 count；start 故意取越界值验证零 count 语义。
				queries[d] = dataeng.DimQuery{Start: int64(rng.IntN(10)) + 5, Count: 0, Step: 1}
				continue
			}
			count := int64(rng.IntN(int(shape[d]) + 1))
			if count == 0 {
				queries[d] = dataeng.DimQuery{
					Start: int64(rng.IntN(int(shape[d]) + 5)),
					Count: 0,
					Step:  1,
				}
				continue
			}
			step := int64(1 + rng.IntN(3))
			if rng.IntN(2) == 0 {
				step = -step
			}
			maxIndex := shape[d] - 1 - (count-1)*abs64(step)
			if maxIndex < 0 {
				// 步长过大放不下 count 个点时退化为单元素查询，保证查询合法。
				count = 1
				step = 1
				maxIndex = shape[d] - 1
			}
			start := int64(rng.IntN(int(maxIndex) + 1))
			if step < 0 {
				start = shape[d] - 1 - start
			}
			queries[d] = dataeng.DimQuery{Start: start, Count: count, Step: step}
		}

		res, err := dataeng.Read(shape, chunkShape, queries, store)
		if err != nil {
			t.Fatalf("iter %d shape=%v queries=%+v: unexpected error %v", iter, shape, queries, err)
		}
		wantValues := expectedValues(store, queries)
		if !sliceEqual(res.Values, wantValues) {
			t.Fatalf("iter %d values mismatch\n shape=%v\n queries=%+v\n got=%v\nwant=%v",
				iter, shape, queries, res.Values, wantValues)
		}

		wantTotal := int64(1)
		for _, q := range queries {
			wantTotal *= q.Count
		}
		if int64(len(res.Values)) != wantTotal {
			t.Fatalf("iter %d: got %d values, want %d", iter, len(res.Values), wantTotal)
		}

		// 同一块最多读取一次：调用次数等于返回的块数。
		if store.calls != len(res.Visits) {
			t.Fatalf("iter %d: reader calls=%d but visits=%d", iter, store.calls, len(res.Visits))
		}

		// 汇报的逐块坐标去重计数后应恰好覆盖每个被查询坐标一次。
		seen := make(map[string]int)
		visitedTotal := 0
		for _, visit := range res.Visits {
			if len(visit.ChunkCoord) != nd {
				t.Fatalf("iter %d: bad chunk coord length", iter)
			}
			for _, coord := range visit.Coords {
				seen[fmt.Sprint(coord)]++
				visitedTotal++
			}
		}
		if int64(visitedTotal) != wantTotal {
			t.Fatalf("iter %d: visited %d coords, want %d", iter, visitedTotal, wantTotal)
		}
		for coordKey, n := range seen {
			if n != 1 {
				t.Fatalf("iter %d: coord %s reported %d times", iter, coordKey, n)
			}
		}

		// 访问顺序必须与查询行主序一致。
		flat := make([]int64, 0, wantTotal)
		for _, coord := range allQueryCoords(queries) {
			flat = append(flat, store.data[store.offset(coord)])
		}
		if !sliceEqual(flat, res.Values) {
			t.Fatalf("iter %d: row-major ordering broken", iter)
		}
	}
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func allQueryCoords(queries []dataeng.DimQuery) [][]int64 {
	dimCoords := make([][]int64, len(queries))
	for i, q := range queries {
		dimCoords[i] = queryCoords(q)
	}
	var out [][]int64
	coord := make([]int64, len(queries))
	var rec func(d int)
	rec = func(d int) {
		if d == len(queries) {
			out = append(out, append([]int64(nil), coord...))
			return
		}
		for _, v := range dimCoords[d] {
			coord[d] = v
			rec(d + 1)
		}
	}
	rec(0)
	return out
}

func TestStridedOrderingAndExtremeStep(t *testing.T) {
	t.Run("row-major order with mixed strides", func(t *testing.T) {
		shape := []int64{4, 6}
		chunkShape := []int64{3, 2}
		store := newRefStore(shape, chunkShape, nil)
		queries := []dataeng.DimQuery{
			{Start: 3, Count: 2, Step: -2}, // 3, 1
			{Start: 1, Count: 3, Step: 2},  // 1, 3, 5
		}
		res, err := dataeng.Read(shape, chunkShape, queries, store)
		if err != nil {
			t.Fatalf("Read failed: %v", err)
		}
		if !sliceEqual(res.Values, expectedValues(store, queries)) {
			t.Fatalf("values = %v, want %v", res.Values, expectedValues(store, queries))
		}
		// Values 必须严格按查询行主序：(3,1),(3,3),(3,5),(1,1),(1,3),(1,5)。
		wantValuesOrder := [][]int64{{3, 1}, {3, 3}, {3, 5}, {1, 1}, {1, 3}, {1, 5}}
		for i, coord := range wantValuesOrder {
			if res.Values[i] != store.data[store.offset(coord)] {
				t.Fatalf("value at %d = %d, want coord %v", i, res.Values[i], coord)
			}
		}
		// Visits 按块坐标分组且字典序排列；每块内部坐标保持查询枚举的相对顺序。
		for i := 1; i < len(res.Visits); i++ {
			if sliceLess(res.Visits[i].ChunkCoord, res.Visits[i-1].ChunkCoord) {
				t.Fatalf("visits not sorted lexicographically at %d", i)
			}
		}
		wantByChunk := map[string][][]int64{
			"[0 0]": {{1, 1}},
			"[0 1]": {{1, 3}},
			"[0 2]": {{1, 5}},
			"[1 0]": {{3, 1}},
			"[1 1]": {{3, 3}},
			"[1 2]": {{3, 5}},
		}
		for _, visit := range res.Visits {
			want, ok := wantByChunk[fmt.Sprint(visit.ChunkCoord)]
			if !ok {
				t.Fatalf("unexpected visit chunk %v", visit.ChunkCoord)
			}
			if !coordEqual(visit.Coords, want) {
				t.Fatalf("chunk %v coords = %v, want %v", visit.ChunkCoord, visit.Coords, want)
			}
		}
	})

	t.Run("min int64 step overflows before reads", func(t *testing.T) {
		calls := 0
		reader := dataeng.ChunkReaderFunc(func(chunkCoord []int64) ([]int64, error) {
			calls++
			return nil, nil
		})
		_, err := dataeng.Read([]int64{10}, []int64{3},
			[]dataeng.DimQuery{{Start: 5, Count: 3, Step: math.MinInt64}}, reader)
		if !errors.Is(err, dataeng.ErrOverflow) {
			t.Fatalf("want ErrOverflow, got %v", err)
		}
		if calls != 0 {
			t.Fatalf("reader called %d times", calls)
		}
	})

	t.Run("single element with min int64 step is valid", func(t *testing.T) {
		shape := []int64{3}
		chunkShape := []int64{2}
		store := newRefStore(shape, chunkShape, nil)
		res, err := dataeng.Read(shape, chunkShape,
			[]dataeng.DimQuery{{Start: 1, Count: 1, Step: math.MinInt64}}, store)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !sliceEqual(res.Values, []int64{2}) {
			t.Fatalf("values = %v, want [2]", res.Values)
		}
	})
}
