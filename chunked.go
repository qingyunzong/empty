package dataeng

import (
	"errors"
	"math"
	"slices"
)

// 维度范围与常见错误。所有错误均为哨兵错误，可用 errors.Is 判定。
var (
	// ErrBadDimensions 表示维数不在 1..8，或形状/块形状/查询长度不匹配。
	ErrBadDimensions = errors.New("dataeng: invalid number of dimensions")
	// ErrBadShape 表示形状出现负值。
	ErrBadShape = errors.New("dataeng: shape extent must be non-negative")
	// ErrBadChunkShape 表示块形状出现非正值。
	ErrBadChunkShape = errors.New("dataeng: chunk shape extent must be positive")
	// ErrZeroStep 表示某一维度查询的 step 为零。
	ErrZeroStep = errors.New("dataeng: query step must be non-zero")
	// ErrNegativeCount 表示某一维度查询的 count 为负。
	ErrNegativeCount = errors.New("dataeng: query count must be non-negative")
	// ErrOutOfBounds 表示查询访问到形状之外的坐标。
	ErrOutOfBounds = errors.New("dataeng: coordinate out of bounds")
	// ErrOverflow 表示坐标跨度或元素总数的乘积在 int64 下溢出。
	ErrOverflow = errors.New("dataeng: integer overflow in index arithmetic")
	// ErrNilReader 表示未注入块读取器。
	ErrNilReader = errors.New("dataeng: nil chunk reader")
	// ErrBadChunk 表示读取器返回的数据长度与块实际边尺寸不一致。
	ErrBadChunk = errors.New("dataeng: chunk length does not match edge extents")
)

// DimQuery 描述单一维度上的访问序列：start、start+step、…、start+(count-1)*step。
// step 必须非零，允许为负数；count 为零时该维不产生任何访问，也不校验 start。
type DimQuery struct {
	Start int64
	Count int64
	Step  int64
}

// ChunkReader 按块坐标读取一整块数据。块坐标与返回的数据均按行主序排列；
// 边块的数据长度等于该块各维实际尺寸的乘积。
type ChunkReader interface {
	ReadChunk(chunkCoord []int64) ([]int64, error)
}

// ChunkVisit 汇报一次查询中某块被实际访问到的信息。
type ChunkVisit struct {
	// ChunkCoord 为块在块网格中的坐标，长度等于数组维数。
	ChunkCoord []int64
	// Coords 为该块被访问到的全部全局坐标，按查询的行主序枚举顺序排列。
	Coords [][]int64
}

// Result 是 Read 的返回值。
type Result struct {
	// Values 按查询索引行主序排列的取数结果。
	Values []int64
	// Visits 按块坐标字典序排列的逐块访问信息。
	Visits []ChunkVisit
}

// ChunkReaderFunc 让普通函数满足 ChunkReader 接口。
type ChunkReaderFunc func(chunkCoord []int64) ([]int64, error)

// ReadChunk 实现 ChunkReader。
func (f ChunkReaderFunc) ReadChunk(chunkCoord []int64) ([]int64, error) {
	return f(chunkCoord)
}

// Read 按 queries 从分块数组中取数。
//
// shape 为数组各维尺寸（非负），chunkShape 为各维块尺寸（正），reader 为
// 注入的块读取器。函数先校验全部访问坐标与乘积溢出，全部通过后才读取块；
// 同一块在本次查询中至多读取一次。
func Read(shape, chunkShape []int64, queries []DimQuery, reader ChunkReader) (Result, error) {
	nd := len(shape)
	if nd < 1 || nd > 8 {
		return Result{}, ErrBadDimensions
	}
	if len(chunkShape) != nd || len(queries) != nd {
		return Result{}, ErrBadDimensions
	}
	if reader == nil {
		return Result{}, ErrNilReader
	}
	for _, extent := range shape {
		if extent < 0 {
			return Result{}, ErrBadShape
		}
	}
	for _, extent := range chunkShape {
		if extent <= 0 {
			return Result{}, ErrBadChunkShape
		}
	}

	// 结构性校验（step 非零、count 非负）与具体坐标无关，先统一完成。
	for dim := range queries {
		if queries[dim].Step == 0 {
			return Result{}, ErrZeroStep
		}
		if queries[dim].Count < 0 {
			return Result{}, ErrNegativeCount
		}
	}

	// 任一维 count 为 0 时结果为空：按约定不校验这些维度的 start，也不读块。
	total := int64(1)
	for dim := range queries {
		var ok bool
		total, ok = mul64(total, queries[dim].Count)
		if !ok {
			return Result{}, ErrOverflow
		}
	}
	if total == 0 {
		return Result{Values: []int64{}, Visits: []ChunkVisit{}}, nil
	}

	// 逐维生成访问坐标。先用 O(维数) 的端点检查保证全部坐标落在形状内，
	// 再展开为坐标列表；坐标跨度与总数的乘积均做溢出检查。
	dimCoords := make([][]int64, nd)
	for dim := range queries {
		q := queries[dim]
		last, ok := mul64(q.Count-1, q.Step)
		if !ok {
			return Result{}, ErrOverflow
		}
		last, ok = add64(q.Start, last)
		if !ok {
			return Result{}, ErrOverflow
		}
		lo, hi := q.Start, last
		if lo > hi {
			lo, hi = hi, lo
		}
		if lo < 0 || hi >= shape[dim] {
			return Result{}, ErrOutOfBounds
		}

		coords := make([]int64, q.Count)
		coord := q.Start
		for i := range coords {
			coords[i] = coord
			if i+1 < len(coords) {
				coord, ok = add64(coord, q.Step)
				if !ok {
					return Result{}, ErrOverflow
				}
			}
		}
		dimCoords[dim] = coords
	}

	type coordEntry struct {
		coord [8]int64
		key   [8]int64
	}
	entries := make([]coordEntry, 0, int(total))
	chunkSet := make(map[[8]int64]struct{})

	// 第一遍：按查询行主序枚举全部坐标，收集去重后的块坐标。
	var current [8]int64
	var enumerate func(dim int)
	enumerate = func(dim int) {
		if dim == nd {
			var key [8]int64
			for d := 0; d < nd; d++ {
				key[d] = current[d] / chunkShape[d]
			}
			entries = append(entries, coordEntry{coord: current, key: key})
			chunkSet[key] = struct{}{}
			return
		}
		for _, coord := range dimCoords[dim] {
			current[dim] = coord
			enumerate(dim + 1)
		}
	}
	enumerate(0)

	keys := make([][8]int64, 0, len(chunkSet))
	for key := range chunkSet {
		keys = append(keys, key)
	}
	slices.SortFunc(keys, func(a, b [8]int64) int {
		return slices.Compare(a[:], b[:])
	})

	type chunkData struct {
		data   []int64
		stride [8]int64
	}
	chunks := make(map[[8]int64]chunkData, len(keys))
	visits := make([]ChunkVisit, 0, len(keys))

	// 第二遍：每块只读一次。边块按实际边尺寸计算行主序步长与长度。
	for _, key := range keys {
		chunkCoord := make([]int64, nd)
		edge := make([]int64, nd)
		expectedLen := int64(1)
		var stride [8]int64
		for d := 0; d < nd; d++ {
			chunkCoord[d] = key[d]
			origin := key[d] * chunkShape[d]
			edge[d] = shape[d] - origin
			var ok bool
			expectedLen, ok = mul64(expectedLen, edge[d])
			if !ok {
				return Result{}, ErrOverflow
			}
		}
		for d := nd - 1; d >= 0; d-- {
			if d == nd-1 {
				stride[d] = 1
			} else {
				stride[d] = stride[d+1] * edge[d+1]
			}
		}

		data, err := reader.ReadChunk(chunkCoord)
		if err != nil {
			return Result{}, err
		}
		if int64(len(data)) != expectedLen {
			return Result{}, ErrBadChunk
		}
		chunks[key] = chunkData{data: data, stride: stride}
		visits = append(visits, ChunkVisit{ChunkCoord: chunkCoord, Coords: [][]int64{}})
	}

	values := make([]int64, len(entries))
	visitByKey := make(map[[8]int64]int, len(keys))
	for i := range visits {
		var key [8]int64
		copy(key[:], visits[i].ChunkCoord)
		visitByKey[key] = i
	}

	// 第三遍：按枚举顺序组装取值，并记录每块的实际访问全局坐标。
	for i, entry := range entries {
		loaded := chunks[entry.key]
		var offset int64
		for d := 0; d < nd; d++ {
			local := entry.coord[d] - entry.key[d]*chunkShape[d]
			offset += local * loaded.stride[d]
		}
		values[i] = loaded.data[offset]

		idx := visitByKey[entry.key]
		coordCopy := make([]int64, nd)
		copy(coordCopy, entry.coord[:nd])
		visits[idx].Coords = append(visits[idx].Coords, coordCopy)
	}

	return Result{Values: values, Visits: visits}, nil
}

// add64 在 int64 下做带溢出检查的加法。
func add64(a, b int64) (int64, bool) {
	if b > 0 && a > math.MaxInt64-b {
		return 0, false
	}
	if b < 0 && a < math.MinInt64-b {
		return 0, false
	}
	return a + b, true
}

// mul64 在 int64 下做带溢出检查的乘法，入参通常为非负索引量。
func mul64(a, b int64) (int64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	if a == math.MinInt64 || b == math.MinInt64 {
		return 0, false
	}
	result := a * b
	if result/a != b {
		return 0, false
	}
	return result, true
}
