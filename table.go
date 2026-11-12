// Package dataeng 读取由接入宿主解析出的 FITS 二进制表数据区。
//
// 数据区由固定宽度的行组成，行内既可以放置定长列，也可以放置变长列的
// P/Q 描述符；变长列的实际数据存放在所有行之后的共享堆中。本包只做
// 按需的区间读取（io.ReaderAt），从不把整张表读入内存，并对每一批读取
// 先完成全部描述符、寻址乘法与元素预算校验，校验通过后才交付数据。
package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
)

// 列类型，对应 FITS TFORM 代码。
const (
	TypeB byte = 'B' // 无符号 8 位整数
	TypeI byte = 'I' // 有符号 16 位整数
	TypeJ byte = 'J' // 有符号 32 位整数
	TypeK byte = 'K' // 有符号 64 位整数
	TypeA byte = 'A' // 原始字节
	TypeX byte = 'X' // 按位取值，高位优先
)

// 变长描述符种类。P 为两个大端有符号 32 位数（count、offset），
// Q 为两个大端有符号 64 位数。
const (
	DescFixed byte = 0
	DescP     byte = 'P' // 8 字节描述符
	DescQ     byte = 'Q' // 16 字节描述符
)

// 调用方配置或数据内容不合法时返回的哨兵错误，使用 errors.Is 判定。
var (
	// ErrConfig 表示 New 阶段发现的列定义、区间参数等静态配置错误。
	ErrConfig = errors.New("dataeng: invalid table configuration")
	// ErrRequest 表示 ReadBatch 的行列选择非法（行号越界、列名未知等）。
	ErrRequest = errors.New("dataeng: invalid batch request")
	// ErrDescriptor 表示变长描述符的 count/offset 不合法。
	ErrDescriptor = errors.New("dataeng: invalid heap descriptor")
	// ErrAddressing 表示寻址乘法/加法溢出，或数据引用超出表区间。
	ErrAddressing = errors.New("dataeng: addressing out of range")
	// ErrBudget 表示本批输出元素总数超过 MaxElements 预算。
	ErrBudget = errors.New("dataeng: output element budget exceeded")
	// ErrShortRead 表示底层 ReaderAt 失败或返回的字节数不足；
	// 此时批次不会交付任何部分数据。
	ErrShortRead = errors.New("dataeng: short read from data area")
)

// Column 描述一列。FixedCount 是固定列的元素数；变长列（Desc 为 P/Q）
// 的元素数由每行的描述符给出，FixedCount 被忽略。
type Column struct {
	Name         string
	Offset       int64 // 行内偏移
	Type         byte
	Desc         byte // DescFixed、DescP、DescQ
	FixedCount   int64
	NullSentinel *int64   // 仅整数列；先判 NULL 再缩放
	Scale        *big.Rat // 仅整数列；物理值 = Scale*原始值 + Zero
	Zero         *big.Rat
}

// Config 是 New 的静态输入。所有长度均为非负精确整数。
type Config struct {
	// Reader 是数据区随机读取器，区间 [0, DataLength) 必须可读；
	// 本包保证绝不读取表区间 [0, W*R+P) 之外的字节。
	Reader interface {
		ReadAt(p []byte, off int64) (n int, err error)
	}
	DataLength int64 // 数据区实际长度，允许表区间末尾另有字节
	RowWidth   int64 // W
	RowCount   int64 // R，可为 0
	ExtraBytes int64 // P，行区之外、表区间之内的额外字节数
	HeapStart  int64 // H，可选；为 0 时默认 W*R
	Columns    []Column

	// MaxElements 限制单批输出元素总数；0 表示不允许任何非空输出。
	// 预算在任何读取发生之前校验。
	MaxElements uint64
}

// Table 是校验通过、可重复取批的只读表句柄。
type Table struct {
	cfg         Config
	heapStart   int64
	tableEnd    int64
	colIndex    map[string]int
	colWidth    []int64
	scaled      []bool
	hasSentinel []bool
}

// New 校验全部静态配置并返回 Table。H 缺省（HeapStart==0）时取 W*R。
func New(cfg Config) (*Table, error) {
	if cfg.Reader == nil {
		return nil, fmt.Errorf("%w: Reader is required", ErrConfig)
	}
	if cfg.DataLength < 0 || cfg.RowWidth < 0 || cfg.RowCount < 0 || cfg.ExtraBytes < 0 || cfg.HeapStart < 0 {
		return nil, fmt.Errorf("%w: length parameters must be non-negative", ErrConfig)
	}
	rowsEnd, ok := mulOK(cfg.RowWidth, cfg.RowCount)
	if !ok {
		return nil, fmt.Errorf("%w: W*R overflows int64", ErrAddressing)
	}
	tableEnd, ok := addOK(rowsEnd, cfg.ExtraBytes)
	if !ok {
		return nil, fmt.Errorf("%w: W*R+P overflows int64", ErrAddressing)
	}
	if tableEnd > cfg.DataLength {
		return nil, fmt.Errorf("%w: table interval [0,%d) exceeds data length %d", ErrAddressing, tableEnd, cfg.DataLength)
	}
	heapStart := cfg.HeapStart
	if heapStart == 0 {
		heapStart = rowsEnd
	}
	if heapStart > tableEnd {
		return nil, fmt.Errorf("%w: heap start %d outside table interval [0,%d)", ErrAddressing, heapStart, tableEnd)
	}
	if len(cfg.Columns) == 0 {
		return nil, fmt.Errorf("%w: at least one column is required", ErrConfig)
	}

	t := &Table{
		cfg:         cfg,
		heapStart:   heapStart,
		tableEnd:    tableEnd,
		colIndex:    make(map[string]int, len(cfg.Columns)),
		colWidth:    make([]int64, len(cfg.Columns)),
		scaled:      make([]bool, len(cfg.Columns)),
		hasSentinel: make([]bool, len(cfg.Columns)),
	}

	for i := range cfg.Columns {
		col := &cfg.Columns[i]
		if col.Name == "" {
			return nil, fmt.Errorf("%w: column %d has empty name", ErrConfig, i)
		}
		if _, dup := t.colIndex[col.Name]; dup {
			return nil, fmt.Errorf("%w: duplicate column name %q", ErrConfig, col.Name)
		}
		if col.Offset < 0 || col.FixedCount < 0 {
			return nil, fmt.Errorf("%w: column %q offset/count must be non-negative", ErrConfig, col.Name)
		}
		if !validType(col.Type) {
			return nil, fmt.Errorf("%w: column %q unknown type %q", ErrConfig, col.Name, col.Type)
		}
		isInt := isIntegerType(col.Type)
		if (col.NullSentinel != nil || col.Scale != nil || col.Zero != nil) && !isInt {
			return nil, fmt.Errorf("%w: column %q: NULL sentinel and scale/zero are only allowed on integer columns", ErrConfig, col.Name)
		}

		width, err := columnWidth(col)
		if err != nil {
			return nil, fmt.Errorf("%w: column %q: %v", ErrConfig, col.Name, err)
		}
		end, ok := addOK(col.Offset, width)
		if !ok || end > cfg.RowWidth {
			return nil, fmt.Errorf("%w: column %q extends beyond row width", ErrConfig, col.Name)
		}
		t.colIndex[col.Name] = i
		t.colWidth[i] = width
		t.hasSentinel[i] = col.NullSentinel != nil
		t.scaled[i] = col.Scale != nil || col.Zero != nil
	}

	// 行内区间两两不得相交（半开区间，零宽列可共用端点）。
	order := make([]int, len(cfg.Columns))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		return cfg.Columns[order[a]].Offset < cfg.Columns[order[b]].Offset
	})
	for i := 1; i < len(order); i++ {
		prev := &cfg.Columns[order[i-1]]
		cur := &cfg.Columns[order[i]]
		prevEnd := prev.Offset + t.colWidth[order[i-1]]
		if cur.Offset < prevEnd {
			return nil, fmt.Errorf("%w: column %q overlaps column %q inside a row", ErrConfig, cur.Name, prev.Name)
		}
	}

	return t, nil
}

// RowWidth、RowCount、HeapStart、TableEnd 返回已校验的几何参数。
func (t *Table) RowWidth() int64  { return t.cfg.RowWidth }
func (t *Table) RowCount() int64  { return t.cfg.RowCount }
func (t *Table) HeapStart() int64 { return t.heapStart }
func (t *Table) TableEnd() int64  { return t.tableEnd }

// Column 返回列定义的副本与列序号。
func (t *Table) Column(name string) (Column, int, bool) {
	if i, ok := t.colIndex[name]; ok {
		return t.cfg.Columns[i], i, true
	}
	return Column{}, 0, false
}

func validType(typ byte) bool {
	switch typ {
	case TypeB, TypeI, TypeJ, TypeK, TypeA, TypeX:
		return true
	}
	return false
}

func isIntegerType(typ byte) bool {
	switch typ {
	case TypeB, TypeI, TypeJ, TypeK:
		return true
	}
	return false
}

// columnWidth 返回列在每行内占用的字节数。
func columnWidth(col *Column) (int64, error) {
	switch col.Desc {
	case DescP:
		return 8, nil
	case DescQ:
		return 16, nil
	case DescFixed:
	default:
		return 0, fmt.Errorf("unknown descriptor kind %q", col.Desc)
	}
	if col.FixedCount == 0 {
		return 0, nil
	}
	if col.Type == TypeX {
		width, ok := bitByteCount(col.FixedCount)
		if !ok {
			return 0, fmt.Errorf("fixed bit width overflows int64")
		}
		return width, nil
	}
	elem := elementWidth(col.Type)
	if elem <= 0 {
		return 0, fmt.Errorf("unknown type %q", col.Type)
	}
	width, ok := mulOK(elem, col.FixedCount)
	if !ok {
		return 0, fmt.Errorf("fixed data width overflows int64")
	}
	return width, nil
}

// elementWidth 返回单个元素的字节数；X 的宽度为 ceil(count/8)，单独处理。
func elementWidth(typ byte) int64 {
	switch typ {
	case TypeB, TypeA:
		return 1
	case TypeI:
		return 2
	case TypeJ:
		return 4
	case TypeK:
		return 8
	case TypeX:
		return 0
	}
	return -1
}

// bitByteCount 返回 count 个按位元素占用的字节数 ceil(count/8)。
func bitByteCount(count int64) (int64, bool) {
	if count < 0 {
		return 0, false
	}
	q, ok := addOK(count, 7)
	if !ok {
		return 0, false
	}
	return q / 8, true
}

// heapBytes 返回指定类型与元素数在堆上占用的字节数。
func heapBytes(typ byte, count int64) (int64, bool) {
	if typ == TypeX {
		return bitByteCount(count)
	}
	elem := elementWidth(typ)
	if elem <= 0 {
		return 0, false
	}
	return mulOK(elem, count)
}

// mulOK 在 int64 范围内计算 a*b，溢出时 ok=false。
func mulOK(a, b int64) (int64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	r := a * b
	if r/b != a {
		return 0, false
	}
	return r, true
}

// addOK 在 int64 范围内计算 a+b，溢出时 ok=false。
func addOK(a, b int64) (int64, bool) {
	r := a + b
	if (r^a)&(r^b) < 0 {
		return 0, false
	}
	return r, true
}
