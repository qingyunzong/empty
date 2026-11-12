// Package varcol 实现内存分析引擎使用的变长字节列。
//
// 一列由三个部分组成：
//   - data：行值共用的字节缓冲；
//   - offsets：长度为行数加一的非降偏移数组，第 i 行的物理区间为
//     [offsets[i], offsets[i+1])；
//   - validity：有效性位图（LSB 在前），置 1 表示该行有效，为 nil 时全部有效。
//
// 被标记为 null 的行仍允许拥有非空的物理区间，该区间中的字节不会被读取。
//
// New 以所有权转移的方式接收 data、offsets、validity：调用成功后调用方不得再
// 修改这三个切片。Slice 返回的列零拷贝地持有同一底层缓冲；Concat 只复制有效
// 行的字节，把它们紧凑重排，null 行的物理区间不参与复制。对外的读取接口不会
// 返回指向共享底层、可被调用方修改的字节切片。
//
// 每个 Column 都是一个持有者：New 产生一个持有者，Slice 再产生一个。持有者必须
// 显式调用 Release；当最后一个持有者被释放时，回收器恰好被调用一次。Release 之后
// 再调用任何方法都会返回错误。
package varcol

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
)

var (
	// ErrInvalidInput 表示构造列时输入不满足契约。
	ErrInvalidInput = errors.New("varcol: invalid input")
	// ErrClosed 表示列已经被释放，不能再访问。
	ErrClosed = errors.New("varcol: column already released")
)

// Recycler 在共享底层缓冲的最后一个持有者释放时被调用，参数为 New 接收的三个
// 原始切片。回收器至多被调用一次，且调用发生在最后一次 Release 内部。
type Recycler func(data []byte, offsets []int32, validity []byte)

// core 是多个切片列共享的引用计数底层缓冲。
type core struct {
	data     []byte
	offsets  []int32
	validity []byte

	recycle Recycler

	mu      sync.Mutex
	refs    int
	closed  bool
	doneOne atomic.Bool
}

// Column 表示变长字节列上的一个持有者。Column 不可拷贝使用：每次需要新的持有者
// 时应当调用 Slice。
type Column struct {
	core *core

	// start/end 是 offsets 上的下标区间 [start, end]，本持有者覆盖第 start 至
	// end-1 行，共 end-start 行。
	start int
	end   int

	released atomic.Bool
}

// New 以所有权转移的方式接收缓冲并构造一个有 rows 行的列。
//
// 校验规则：rows 非负；offsets 长度必须为 rows+1；offsets 元素非降且都落在
// [0, len(data)] 内；validity 为 nil 或至少能容纳 rows 个比特。recycle 可为 nil，
// 表示无需回收。校验失败时返回包装了 ErrInvalidInput 的错误，且不会调用回收器。
func New(data []byte, offsets []int32, validity []byte, rows int, recycle Recycler) (*Column, error) {
	if err := validateInputs(data, offsets, validity, rows); err != nil {
		return nil, err
	}

	c := &core{
		data:     data,
		offsets:  offsets,
		validity: validity,
		recycle:  recycle,
		refs:     1,
	}
	return &Column{core: c, start: 0, end: rows}, nil
}

func validateInputs(data []byte, offsets []int32, validity []byte, rows int) error {
	if rows < 0 {
		return errors.Join(ErrInvalidInput, errors.New("rows must be non-negative"))
	}
	if len(offsets) != rows+1 {
		return errors.Join(ErrInvalidInput, errors.New("len(offsets) must equal rows+1"))
	}
	need := (rows + 7) / 8
	if validity != nil && len(validity) < need {
		return errors.Join(ErrInvalidInput, errors.New("validity bitmap too small for rows"))
	}

	dataLen := int32(len(data))
	prev := int32(0)
	for i, off := range offsets {
		if off < 0 || off > dataLen {
			return errors.Join(ErrInvalidInput, errors.New("offset out of data bounds"))
		}
		if i > 0 && off < prev {
			return errors.Join(ErrInvalidInput, errors.New("offsets must be non-decreasing"))
		}
		prev = off
	}
	return nil
}

// Len 返回列中的行数。
func (c *Column) Len() (int, error) {
	if c == nil {
		return 0, ErrClosed
	}
	if c.released.Load() {
		return 0, ErrClosed
	}
	return c.end - c.start, nil
}

// IsNull 报告第 i 行是否为 null。
func (c *Column) IsNull(i int) (bool, error) {
	if err := c.checkRow(i); err != nil {
		return false, err
	}
	return !c.rowValid(c.start + i), nil
}

// Get 返回第 i 行的拷贝。null 行返回 (nil, true, nil)；即使 null 行拥有非空物理
// 区间，该区间也不会被读取。返回的切片由调用方独占，修改它不会影响共享底层。
func (c *Column) Get(i int) (value []byte, isNull bool, err error) {
	lo, hi, ok, err := c.rowRange(i)
	if err != nil {
		return nil, false, err
	}
	if !ok {
		return nil, true, nil
	}
	out := make([]byte, hi-lo)
	copy(out, c.core.data[lo:hi])
	return out, false, nil
}

// AppendValue 把第 i 行的字节追加到 dst 并返回新切片；null 行不追加任何字节，
// 返回 (dst, true, nil)。该方法不暴露共享底层，可复用调用方自己的缓冲。
func (c *Column) AppendValue(dst []byte, i int) ([]byte, bool, error) {
	lo, hi, ok, err := c.rowRange(i)
	if err != nil {
		return dst, false, err
	}
	if !ok {
		return dst, true, nil
	}
	return append(dst, c.core.data[lo:hi]...), false, nil
}

// WriteValueTo 把第 i 行的字节写入 w；null 行写入零字节。写入按分块进行，不会把
// 共享底层切片交给 w。
func (c *Column) WriteValueTo(w io.Writer, i int) (int64, error) {
	lo, hi, ok, err := c.rowRange(i)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, nil
	}

	var chunk [4096]byte
	var total int64
	pos := int(lo)
	for pos < int(hi) {
		n := copy(chunk[:], c.core.data[pos:hi])
		written, werr := w.Write(chunk[:n])
		total += int64(written)
		if werr != nil {
			return total, werr
		}
		if written != n {
			return total, io.ErrShortWrite
		}
		pos += n
	}
	return total, nil
}

// Slice 返回覆盖第 start 至 end-1 行（共 end-start 行）的新持有者。新列零拷贝地
// 共享同一底层缓冲，并使共享缓冲的引用计数加一。多个切片允许重叠。
func (c *Column) Slice(start, end int) (*Column, error) {
	if c == nil || c.released.Load() {
		return nil, ErrClosed
	}
	rows := c.end - c.start
	if start < 0 || end < start || end > rows {
		return nil, errors.Join(ErrInvalidInput, errors.New("slice range out of bounds"))
	}

	c.core.mu.Lock()
	if c.core.closed {
		c.core.mu.Unlock()
		return nil, ErrClosed
	}
	c.core.refs++
	c.core.mu.Unlock()

	return &Column{
		core:  c.core,
		start: c.start + start,
		end:   c.start + end,
	}, nil
}

// Release 释放当前持有者。最后一个持有者释放时，回收器恰好被调用一次。重复释放
// 返回包装了 ErrClosed 的错误，且不会再次触发回收。
func (c *Column) Release() error {
	if c == nil {
		return ErrClosed
	}
	if !c.released.CompareAndSwap(false, true) {
		return errors.Join(ErrClosed, errors.New("double release"))
	}

	c.core.mu.Lock()
	c.core.refs--
	refs := c.core.refs
	if refs == 0 {
		c.core.closed = true
	}
	c.core.mu.Unlock()

	if refs == 0 && c.core.doneOne.CompareAndSwap(false, true) {
		if c.core.recycle != nil {
			c.core.recycle(c.core.data, c.core.offsets, c.core.validity)
		}
	}
	return nil
}

// Concat 按顺序拼接 cols 中的有效行，返回一个紧凑排列的新列。
//
// 每个输入列的 null 行都会被跳过：其物理区间中的字节不复制，输出中仅保留 null
// 标记。有效行的字节被依次拷贝到一块新的连续缓冲中，因此输出不与任何输入共享
// 底层。任一输入为 nil、已释放或输入列表为空时返回包装了 ErrInvalidInput 的错误。
// 输出列使用传入的 recycle 作为回收器（可为 nil）。
func Concat(cols []*Column, recycle Recycler) (*Column, error) {
	if len(cols) == 0 {
		return nil, errors.Join(ErrInvalidInput, errors.New("no columns to concat"))
	}

	totalRows := 0
	for _, col := range cols {
		if col == nil || col.released.Load() {
			return nil, errors.Join(ErrInvalidInput, errors.New("nil or released column"))
		}
		totalRows += col.end - col.start
	}

	data := make([]byte, 0)
	offsets := make([]int32, 0, totalRows+1)
	validity := make([]byte, (totalRows+7)/8)

	outRow := 0
	offsets = append(offsets, 0)
	for _, col := range cols {
		for local := 0; local < col.end-col.start; local++ {
			abs := col.start + local
			if !col.rowValid(abs) {
				// null 行：不复制其物理区间中的任何字节。
				offsets = append(offsets, int32(len(data)))
				outRow++
				continue
			}
			lo := col.core.offsets[abs]
			hi := col.core.offsets[abs+1]
			data = append(data, col.core.data[lo:hi]...)
			offsets = append(offsets, int32(len(data)))
			validity[outRow/8] |= 1 << uint(outRow%8)
			outRow++
		}
	}

	return New(data, offsets, validity, outRow, recycle)
}

// rowRange 返回第 i 行在共享 data 中的物理区间。ok 为 false 表示该行是 null。
func (c *Column) rowRange(i int) (lo, hi int32, ok bool, err error) {
	if err = c.checkRow(i); err != nil {
		return 0, 0, false, err
	}
	abs := c.start + i
	if !c.rowValid(abs) {
		return 0, 0, false, nil
	}
	return c.core.offsets[abs], c.core.offsets[abs+1], true, nil
}

func (c *Column) checkRow(i int) error {
	if c == nil || c.released.Load() {
		return ErrClosed
	}
	if i < 0 || i >= c.end-c.start {
		return errors.Join(ErrInvalidInput, errors.New("row index out of bounds"))
	}
	return nil
}

// rowValid 报告 offsets 下标 abs 对应的行是否有效。
func (c *Column) rowValid(abs int) bool {
	if c.core.validity == nil {
		return true
	}
	bit := c.core.validity[abs/8] >> uint(abs%8)
	return bit&1 == 1
}

// refs 返回共享底层当前的持有者数量，仅供测试使用。
func (c *Column) refs() int {
	c.core.mu.Lock()
	defer c.core.mu.Unlock()
	return c.core.refs
}
