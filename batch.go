package dataeng

import (
	"encoding/binary"
	"fmt"
	"math/big"
)

// Range 是数据区内的一个半开物理字节区间 [Offset, Offset+Length)。
// 零长数组的 Source 为零值 Range，不对应任何读取。
type Range struct {
	Offset int64
	Length int64
}

// Array 是一个 (行, 列) 单元解码后的结果。各类型切片只有一个会被填充：
// 缩放整数列填 Values（*big.Rat，NULL 位置为 nil）；
// 未缩放整数列按宽度填 U8/I16/I32/I64，带哨兵时同时给出等长 Nulls；
// A 填 Bytes，X 填 Bits，零长单元对应长度为 0 的切片。
// 返回的切片每次读取都会得到独立副本，修改它不会影响其他批次或数组。
type Array struct {
	Column string
	Row    int64
	Source Range

	U8     []uint8
	I16    []int16
	I32    []int32
	I64    []int64
	Bytes  []byte
	Bits   []bool
	Values []*big.Rat
	Nulls  []bool
}

// Len 返回数组元素数。
func (a Array) Len() int {
	switch {
	case a.U8 != nil:
		return len(a.U8)
	case a.I16 != nil:
		return len(a.I16)
	case a.I32 != nil:
		return len(a.I32)
	case a.I64 != nil:
		return len(a.I64)
	case a.Bytes != nil:
		return len(a.Bytes)
	case a.Bits != nil:
		return len(a.Bits)
	case a.Values != nil:
		return len(a.Values)
	}
	return 0
}

// ReadCall 记录一次底层 ReadAt 的物理区间。
type ReadCall struct {
	Offset int64
	Length int64
}

// ReadLog 记录本批实际发生的读取。完全相同的物理字节区间在同一批内
// 只会触发一次 ReadAt。
type ReadLog struct {
	Calls []ReadCall
}

// TotalBytes 返回实际读取的字节总数（含重复区间的重复计数）。
func (l ReadLog) TotalBytes() int64 {
	var total int64
	for _, call := range l.Calls {
		total += call.Length
	}
	return total
}

// Batch 是一次 ReadBatch 的交付结果。Arrays 严格按请求中 (行,列) 的
// 顺序排列，调用方给定的行顺序与重复行都会被保留。
type Batch struct {
	Arrays []Array
	Reads  ReadLog
}

// cellPlan 是通过全部校验、等待读取解码的单元计划。
type cellPlan struct {
	colIndex int
	row      int64
	count    int64
	source   Range
}

// ReadBatch 按 rows 与 columnNames 选择单元返回批次。rows 中的行号顺序
// 与重复项原样保留；columnNames 同理允许重复列名。
//
// 先完成全部描述符解析、堆寻址、元素预算与乘法溢出校验，然后才发起
// 数据读取；任何错误都不会交付部分数据。
func (t *Table) ReadBatch(rows []int64, columnNames []string) (*Batch, error) {
	for _, row := range rows {
		if row < 0 || row >= t.cfg.RowCount {
			return nil, fmt.Errorf("%w: row %d outside [0,%d)", ErrRequest, row, t.cfg.RowCount)
		}
	}
	colIndexes := make([]int, len(columnNames))
	for i, name := range columnNames {
		idx, ok := t.colIndex[name]
		if !ok {
			return nil, fmt.Errorf("%w: unknown column %q", ErrRequest, name)
		}
		colIndexes[i] = idx
	}
	if len(rows) == 0 || len(columnNames) == 0 {
		return &Batch{}, nil
	}

	plans := make([]cellPlan, 0, len(rows)*len(columnNames))
	var elementTotal uint64

	// 第一阶段：解析全部描述符并完成寻址/预算校验。
	for _, row := range rows {
		rowStart, ok := mulOK(row, t.cfg.RowWidth)
		if !ok {
			return nil, fmt.Errorf("%w: row %d start overflows", ErrAddressing, row)
		}
		for _, idx := range colIndexes {
			inlineOff, ok := addOK(rowStart, t.cfg.Columns[idx].Offset)
			if !ok {
				return nil, fmt.Errorf("%w: column %q row %d inline offset overflows", ErrAddressing, t.cfg.Columns[idx].Name, row)
			}

			var plan cellPlan
			var err error
			if t.cfg.Columns[idx].Desc == DescFixed {
				plan, err = t.planFixed(idx, &t.cfg.Columns[idx], row, inlineOff)
			} else {
				plan, err = t.planVariable(idx, &t.cfg.Columns[idx], row, inlineOff)
			}
			if err != nil {
				return nil, err
			}
			plans = append(plans, plan)

			sum, ok := addBudget(elementTotal, uint64(plan.count))
			if !ok {
				return nil, fmt.Errorf("%w: element count overflows budget accumulator", ErrBudget)
			}
			elementTotal = sum
		}
	}

	if elementTotal > t.cfg.MaxElements {
		return nil, fmt.Errorf("%w: batch needs %d elements, limit is %d", ErrBudget, elementTotal, t.cfg.MaxElements)
	}

	// 第二阶段：按计划读取。相同物理区间全程共用一份缓存，只读一次。
	cache := newReadCache(t.cfg.Reader)
	arrays := make([]Array, 0, len(plans))
	for _, plan := range plans {
		data, err := cache.fetch(plan.source)
		if err != nil {
			return nil, err
		}
		arrays = append(arrays, t.decode(plan.colIndex, plan, data))
	}

	return &Batch{Arrays: arrays, Reads: ReadLog{Calls: cache.snapshot()}}, nil
}

func (t *Table) planFixed(idx int, col *Column, row, inlineOff int64) (cellPlan, error) {
	width := t.colWidth[idx]
	end, ok := addOK(inlineOff, width)
	if !ok || end > t.tableEnd {
		return cellPlan{}, fmt.Errorf("%w: column %q row %d fixed bytes leave table interval", ErrAddressing, col.Name, row)
	}
	return cellPlan{
		colIndex: idx,
		row:      row,
		count:    col.FixedCount,
		source:   Range{Offset: inlineOff, Length: width},
	}, nil
}

func (t *Table) planVariable(idx int, col *Column, row, descOff int64) (cellPlan, error) {
	descWidth := t.colWidth[idx]
	descEnd, ok := addOK(descOff, descWidth)
	if !ok || descEnd > t.tableEnd {
		return cellPlan{}, fmt.Errorf("%w: column %q row %d descriptor leaves table interval", ErrAddressing, col.Name, row)
	}

	raw := make([]byte, descWidth)
	if err := readFull(t.cfg.Reader, raw, descOff); err != nil {
		return cellPlan{}, err
	}

	var count, relOffset int64
	if col.Desc == DescP {
		count = int64(int32(binary.BigEndian.Uint32(raw[0:4])))
		relOffset = int64(int32(binary.BigEndian.Uint32(raw[4:8])))
	} else {
		count = int64(binary.BigEndian.Uint64(raw[0:8]))
		relOffset = int64(binary.BigEndian.Uint64(raw[8:16]))
	}

	if count < 0 {
		return cellPlan{}, fmt.Errorf("%w: column %q row %d negative count %d", ErrDescriptor, col.Name, row, count)
	}
	// count==0 时 offset 不参与寻址，也不验证符号。
	if count == 0 {
		return cellPlan{colIndex: idx, row: row, count: 0}, nil
	}
	if relOffset < 0 {
		return cellPlan{}, fmt.Errorf("%w: column %q row %d negative offset %d", ErrDescriptor, col.Name, row, relOffset)
	}

	width, ok := heapBytes(col.Type, count)
	if !ok {
		return cellPlan{}, fmt.Errorf("%w: column %q row %d heap size overflows", ErrAddressing, col.Name, row)
	}
	heapOff, ok := addOK(t.heapStart, relOffset)
	if !ok {
		return cellPlan{}, fmt.Errorf("%w: column %q row %d heap offset overflows", ErrAddressing, col.Name, row)
	}
	end, ok := addOK(heapOff, width)
	if !ok || end > t.tableEnd {
		return cellPlan{}, fmt.Errorf("%w: column %q row %d heap range [%d,%d) outside table interval ending %d",
			ErrAddressing, col.Name, row, heapOff, end, t.tableEnd)
	}

	return cellPlan{
		colIndex: idx,
		row:      row,
		count:    count,
		source:   Range{Offset: heapOff, Length: width},
	}, nil
}

func addBudget(total, add uint64) (uint64, bool) {
	sum := total + add
	if sum < total {
		return 0, false
	}
	return sum, true
}

// readerAt 是本包依赖的最小随机读取接口，io.ReaderAt 天然满足。
type readerAt interface {
	ReadAt(p []byte, off int64) (int, error)
}

// readFull 严格读取 len(p) 字节；任何失败或短读都返回 ErrShortRead，
// 调用方在交付前统一中止，因此不会产生部分交付。
func readFull(reader readerAt, p []byte, off int64) error {
	if len(p) == 0 {
		return nil
	}
	n, err := reader.ReadAt(p, off)
	if err != nil || n != len(p) {
		return fmt.Errorf("%w: wanted %d bytes at %d, got %d (err=%v)", ErrShortRead, len(p), off, n, err)
	}
	return nil
}

// readCache 对完全相同的物理区间去重，保证同批只读一次。
type readCache struct {
	reader readerAt
	data   map[Range][]byte
	calls  []ReadCall
}

func newReadCache(reader readerAt) *readCache {
	return &readCache{reader: reader, data: make(map[Range][]byte)}
}

func (c *readCache) fetch(r Range) ([]byte, error) {
	if r.Length == 0 {
		return nil, nil
	}
	if buf, ok := c.data[r]; ok {
		out := make([]byte, r.Length)
		copy(out, buf)
		return out, nil
	}
	buf := make([]byte, r.Length)
	if err := readFull(c.reader, buf, r.Offset); err != nil {
		return nil, err
	}
	c.data[r] = buf
	c.calls = append(c.calls, ReadCall{Offset: r.Offset, Length: r.Length})
	out := make([]byte, r.Length)
	copy(out, buf)
	return out, nil
}

func (c *readCache) snapshot() []ReadCall {
	if len(c.calls) == 0 {
		return []ReadCall{}
	}
	out := make([]ReadCall, len(c.calls))
	copy(out, c.calls)
	return out
}

// decode 将原始字节解码为独立持有的结果数组。
func (t *Table) decode(idx int, plan cellPlan, raw []byte) Array {
	col := &t.cfg.Columns[idx]
	array := Array{Column: col.Name, Row: plan.row, Source: plan.source}
	count := int(plan.count)

	switch col.Type {
	case TypeB:
		values := make([]uint8, count)
		copy(values, raw)
		array.U8 = values
		t.decodeInteger(col, idx, count, &array, func(i int) int64 { return int64(array.U8[i]) })
	case TypeI:
		values := make([]int16, count)
		for i := range values {
			values[i] = int16(binary.BigEndian.Uint16(raw[2*i:]))
		}
		array.I16 = values
		t.decodeInteger(col, idx, count, &array, func(i int) int64 { return int64(array.I16[i]) })
	case TypeJ:
		values := make([]int32, count)
		for i := range values {
			values[i] = int32(binary.BigEndian.Uint32(raw[4*i:]))
		}
		array.I32 = values
		t.decodeInteger(col, idx, count, &array, func(i int) int64 { return int64(array.I32[i]) })
	case TypeK:
		values := make([]int64, count)
		for i := range values {
			values[i] = int64(binary.BigEndian.Uint64(raw[8*i:]))
		}
		array.I64 = values
		t.decodeInteger(col, idx, count, &array, func(i int) int64 { return array.I64[i] })
	case TypeA:
		values := make([]byte, count)
		copy(values, raw)
		array.Bytes = values
	case TypeX:
		values := make([]bool, count)
		for i := 0; i < count; i++ {
			values[i] = raw[i/8]&(0x80>>uint(i%8)) != 0
		}
		array.Bits = values
	}

	return array
}

// decodeInteger 处理整数列的 NULL 判定与缩放。未缩放且无哨兵的列保留
// 类型切片；带哨兵的未缩放列补充等长 Nulls；缩放列输出 *big.Rat，NULL
// 位置为 nil 且不参与乘法（先判 NULL 再缩放）。
func (t *Table) decodeInteger(col *Column, idx, count int, array *Array, valueAt func(int) int64) {
	if t.hasSentinel[idx] && !t.scaled[idx] {
		nulls := make([]bool, count)
		for i := 0; i < count; i++ {
			nulls[i] = valueAt(i) == *col.NullSentinel
		}
		array.Nulls = nulls
		return
	}
	if !t.scaled[idx] {
		return
	}

	values := make([]*big.Rat, count)
	scale := col.Scale
	if scale == nil {
		scale = big.NewRat(1, 1)
	}
	zero := col.Zero
	if zero == nil {
		zero = big.NewRat(0, 1)
	}
	for i := 0; i < count; i++ {
		raw := valueAt(i)
		if t.hasSentinel[idx] && raw == *col.NullSentinel {
			continue // NULL：保留 nil，不做缩放
		}
		v := new(big.Rat).SetFrac(big.NewInt(raw), big.NewInt(1))
		v.Mul(v, scale)
		v.Add(v, zero)
		values[i] = v
	}
	array.Values = values
	array.U8, array.I16, array.I32, array.I64 = nil, nil, nil, nil
}
