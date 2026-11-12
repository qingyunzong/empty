// Package patchedbase 实现本工程封闭定义的单 run patched-base 整数体解码器。
//
// 一个 run 体依次由三部分组成：
//   - BW 字节大端基值，最高位为符号位（绝对值编码，非二补码）；
//   - N 个 W 位无符号低部，高位先行连续打包，按字节补零；
//   - P 个补丁槽，槽宽 F 取允许位宽集合中不小于 G+PW 的最小值，
//     高位先行连续打包，按字节补零。
//
// 解码器通过 Push 接受任意字节切块，Finish 时统一校验体长、尾填充、
// 补丁定位与数值范围；任一校验失败后该实例不可继续使用，宿主可新建
// 实例处理下一个 run。
package patchedbase

import (
	"fmt"
	"math"
	"math/big"
)

// Kind 标识可辨识的失败类别。
type Kind int

const (
	KindOK               Kind = iota
	KindInvalidParameter      // 参数错误（含声明体长与计算体长不符）
	KindTruncated             // 体截断
	KindExtraBytes            // 声明体长之外的额外字节
	KindPadding               // 段尾填充位或补丁槽保留高位非 0
	KindBadContinuation       // 非法延续槽
	KindPatchPosition         // 补丁位置越界或与上一个真补丁重复
	KindOverflow              // 修复结果超出 int64 范围
	KindState                 // 失败后继续 Push 或重复 Finish
)

// Error 携带结构化失败类别，宿主可用 errors.As 取 Kind 分别处理。
type Error struct {
	Kind Kind
	Msg  string
}

func (e *Error) Error() string {
	return e.Msg
}

// Is 使包装后的错误仍可按 Kind 比较。
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Kind == e.Kind
}

// 各类可辨识失败的哨兵错误。
var (
	ErrInvalidParameter = &Error{Kind: KindInvalidParameter, Msg: "patchedbase: invalid parameter"}
	ErrTruncated        = &Error{Kind: KindTruncated, Msg: "patchedbase: truncated run body"}
	ErrExtraBytes       = &Error{Kind: KindExtraBytes, Msg: "patchedbase: extra bytes beyond declared run body"}
	ErrPadding          = &Error{Kind: KindPadding, Msg: "patchedbase: nonzero padding or reserved bits"}
	ErrBadContinuation  = &Error{Kind: KindBadContinuation, Msg: "patchedbase: illegal long-gap continuation slot"}
	ErrPatchPosition    = &Error{Kind: KindPatchPosition, Msg: "patchedbase: patch position out of range or duplicated"}
	ErrOverflow         = &Error{Kind: KindOverflow, Msg: "patchedbase: reconstructed value overflows int64"}
	ErrState            = &Error{Kind: KindState, Msg: "patchedbase: decoder already finished or failed"}
)

// Params 是容器为单个 run 提供的全部元数据。
type Params struct {
	N          int // 值个数，1..512
	W          int // 低部位宽，取自允许位宽集合
	BW         int // 基值字节数，1..8
	PW         int // patch 位宽，取自允许位宽集合
	G          int // gap 位宽，1..8
	P          int // 补丁槽数，0..31
	BodyLength int // 容器声明的完整 run 体字节长度
}

// BitRange 描述字段在 run 体内的绝对位范围，位序号从体起始的最高位起算。
type BitRange struct {
	Start uint64
	Bits  uint8
}

// PatchInfo 只挂在真正打补丁的值上；延续槽不是数值，只出现在 GapSources 中。
type PatchInfo struct {
	Slot       int      // 该真补丁所在槽序号（0 起）
	SlotRange  BitRange // 整个补丁槽的位范围
	GapSources []int    // 归并到该补丁的延续槽序号
}

// Value 是一个解码结果值及其溯源位范围。
type Value struct {
	Value     int64
	LowRange  BitRange   // 该值低部的位范围
	BaseRange BitRange   // 基值字段的位范围（每个值相同）
	Patch     *PatchInfo // 非补丁值为 nil
}

// Result 是单个 run 成功解码后的一次性交付。
type Result struct {
	Base   int64
	Values []Value
}

// Decoder 是单 run 有状态解码器。零值不可用，必须经 New 创建。
type Decoder struct {
	params Params
	f      int
	length int

	buf   []byte
	extra bool
	err   error
	done  bool
}

// isValidWidth 判断 w 是否属于 {1..24,26,28,30,32,40,48,56,64}。
func isValidWidth(w int) bool {
	if w >= 1 && w <= 24 {
		return true
	}
	switch w {
	case 26, 28, 30, 32, 40, 48, 56, 64:
		return true
	}
	return false
}

// slotWidth 返回允许集合中最小的不小于 need 的位宽。
func slotWidth(need int) int {
	for w := need; w <= 64; w++ {
		if isValidWidth(w) {
			return w
		}
	}
	return 0
}

// validate 先校验全部参数，并返回槽宽 F 与计算体长。
func (p Params) validate() (f int, length int, err error) {
	fail := func(format string, args ...any) error {
		return fmt.Errorf("%w: %s", ErrInvalidParameter, fmt.Sprintf(format, args...))
	}
	if p.N < 1 || p.N > 512 {
		return 0, 0, fail("N out of range [1,512]: %d", p.N)
	}
	if !isValidWidth(p.W) {
		return 0, 0, fail("W not in allowed width set: %d", p.W)
	}
	if !isValidWidth(p.PW) {
		return 0, 0, fail("PW not in allowed width set: %d", p.PW)
	}
	if p.BW < 1 || p.BW > 8 {
		return 0, 0, fail("BW out of range [1,8]: %d", p.BW)
	}
	if p.G < 1 || p.G > 8 {
		return 0, 0, fail("G out of range [1,8]: %d", p.G)
	}
	if p.P < 0 || p.P > 31 {
		return 0, 0, fail("P out of range [0,31]: %d", p.P)
	}
	if p.W+p.PW > 64 {
		return 0, 0, fail("W+PW exceeds 64: %d+%d", p.W, p.PW)
	}
	if p.G+p.PW > 64 {
		return 0, 0, fail("G+PW exceeds 64: %d+%d", p.G, p.PW)
	}
	if p.BodyLength < 0 {
		return 0, 0, fail("negative body length: %d", p.BodyLength)
	}
	f = slotWidth(p.G + p.PW)
	length = p.BW + (p.N*p.W+7)/8 + (p.P*f+7)/8
	if p.BodyLength != length {
		return 0, 0, fail("declared body length %d != computed %d", p.BodyLength, length)
	}
	return f, length, nil
}

// New 校验参数并创建解码器；所有缓存容量只由校验后的参数推导，
// 不按不可信的声明长度任意分配。
func New(p Params) (*Decoder, error) {
	f, length, err := p.validate()
	if err != nil {
		return nil, err
	}
	return &Decoder{
		params: p,
		f:      f,
		length: length,
		buf:    make([]byte, 0, length),
	}, nil
}

// Push 接受任意字节切块。超出声明体长的字节被留在边界外并标记，
// 到 Finish 时报额外字节；失败后的 Push 直接返回既有错误。
func (d *Decoder) Push(chunk []byte) error {
	if d == nil {
		return fmt.Errorf("%w: push on nil decoder (New failed)", ErrInvalidParameter)
	}
	if d.err != nil {
		return d.err
	}
	if d.done {
		return d.fail(ErrState, "push after finish")
	}
	remaining := d.length - len(d.buf)
	if remaining <= 0 {
		if len(chunk) > 0 {
			d.extra = true
		}
		return nil
	}
	if len(chunk) <= remaining {
		d.buf = append(d.buf, chunk...)
		return nil
	}
	d.buf = append(d.buf, chunk[:remaining]...)
	d.extra = true
	return nil
}

func (d *Decoder) fail(sentinel error, format string, args ...any) error {
	d.err = fmt.Errorf("%w: %s", sentinel, fmt.Sprintf(format, args...))
	return d.err
}

// bitReader 是高位先行（MSB-first）的绝对位游标读取器。
type bitReader struct {
	data []byte
	pos  uint64
}

// read 从当前位游标读取 bits 位（bits <= 64），跨字节拼接。
func (r *bitReader) read(bits int) (uint64, error) {
	if bits <= 0 {
		return 0, nil
	}
	if bits > 64 {
		return 0, fmt.Errorf("%w: cannot read %d bits into uint64", ErrInvalidParameter, bits)
	}
	end := r.pos + uint64(bits)
	if end > uint64(len(r.data))*8 {
		return 0, ErrTruncated
	}
	var v uint64
	for remaining := bits; remaining > 0; {
		byteIdx := int(r.pos >> 3)
		bitOff := int(r.pos & 7)
		avail := 8 - bitOff
		take := remaining
		if take > avail {
			take = avail
		}
		mask := uint64(1)<<uint(take) - 1
		part := uint64(r.data[byteIdx]>>uint(avail-take)) & mask
		v = v<<uint(take) | part
		r.pos += uint64(take)
		remaining -= take
	}
	return v, nil
}

// readBig 逐位把 bits 位拼装成数学整数，用于基值等需要避开 uint64 边界的场合。
func (r *bitReader) readBig(bits int) (*big.Int, error) {
	end := r.pos + uint64(bits)
	if end > uint64(len(r.data))*8 {
		return nil, ErrTruncated
	}
	x := new(big.Int)
	for i := 0; i < bits; i++ {
		byteIdx := r.pos >> 3
		bitOff := uint(r.pos & 7)
		bit := uint((r.data[byteIdx] >> uint(7-bitOff)) & 1)
		x.Lsh(x, 1).Or(x, big.NewInt(int64(bit)))
		r.pos++
	}
	return x, nil
}

// checkTailPadding 要求从当前位游标到下一字节边界的填充位全为 0。
func (r *bitReader) checkTailPadding(data []byte) error {
	aligned := (r.pos + 7) &^ 7
	if aligned > uint64(len(data))*8 {
		return ErrTruncated
	}
	for r.pos < aligned {
		bit, err := r.read(1)
		if err != nil {
			return err
		}
		if bit != 0 {
			return ErrPadding
		}
	}
	return nil
}

type patchSlot struct {
	patch uint64
	gap   uint64
	start uint64
}

// Finish 校验体长与尾填充，解码并应用补丁，做数学整数范围检查。
// 成功仅交付一次；重复调用或失败后调用返回状态错误。
func (d *Decoder) Finish() (*Result, error) {
	if d == nil {
		return nil, fmt.Errorf("%w: finish on nil decoder (New failed)", ErrInvalidParameter)
	}
	if d.err != nil {
		return nil, d.err
	}
	if d.done {
		return nil, d.fail(ErrState, "finish called more than once")
	}
	d.done = true

	if d.extra {
		return nil, d.fail(ErrExtraBytes, "declared length %d", d.length)
	}
	if len(d.buf) != d.length {
		return nil, d.fail(ErrTruncated, "got %d bytes, need %d", len(d.buf), d.length)
	}

	p := d.params
	r := &bitReader{data: d.buf}

	// 基值：BW 字节大端，最高位是符号位，清符号位后为绝对值。
	// BW=8 时符号位落在第 63 位，用数学整数读取以避开 uint64 掩码边界。
	rawBase, err := r.readBig(p.BW * 8)
	if err != nil {
		return nil, d.fail(err, "reading base value")
	}
	signed := rawBase.Bit(p.BW*8-1) == 1
	// 用掩码清符号位：SetBit 清除唯一置位位会把值置成 nil，掩码方式保留绝对值结构。
	signMask := new(big.Int).Sub(
		new(big.Int).Lsh(big.NewInt(1), uint(p.BW*8-1)),
		big.NewInt(1),
	)
	baseBig := new(big.Int).And(rawBase, signMask)
	// 符号位已由掩码清掉，剩余绝对值 <= 2^63-1，Uint64 可承载。
	base := int64(baseBig.Uint64())
	if signed {
		base = -base // 取相反数而非二补码扩展；负零得 0
	}
	baseBig = big.NewInt(base)
	baseRange := BitRange{Start: 0, Bits: uint8(p.BW * 8)}

	// N 个 W 位无符号低部，全部读完后才处理补丁。
	lowStart := r.pos
	lows := make([]uint64, p.N)
	lowRanges := make([]BitRange, p.N)
	for i := 0; i < p.N; i++ {
		low, err := r.read(p.W)
		if err != nil {
			return nil, d.fail(err, "reading low part %d", i)
		}
		lows[i] = low
		lowRanges[i] = BitRange{Start: lowStart + uint64(i*p.W), Bits: uint8(p.W)}
	}
	if err := r.checkTailPadding(d.buf); err != nil {
		return nil, d.fail(err, "low-part segment padding")
	}

	// P 个补丁槽，槽宽 F。
	slots := make([]patchSlot, 0, p.P)
	gapMask := uint64(1)<<uint(p.G) - 1
	patchMask := uint64(1)<<uint(p.PW) - 1
	for s := 0; s < p.P; s++ {
		slotStart := r.pos
		raw, err := r.read(d.f)
		if err != nil {
			return nil, d.fail(err, "reading patch slot %d", s)
		}
		if reserved := p.G + p.PW; d.f > reserved {
			if raw>>uint(reserved) != 0 {
				return nil, d.fail(ErrPadding, "nonzero reserved high bits in slot %d", s)
			}
		}
		slots = append(slots, patchSlot{
			patch: raw & patchMask,
			gap:   (raw >> uint(p.PW)) & gapMask,
			start: slotStart,
		})
	}
	if err := r.checkTailPadding(d.buf); err != nil {
		return nil, d.fail(err, "patch-slot segment padding")
	}

	// 严格补丁定位。
	cursor := 0
	lastPos := -1
	pendingGaps := make([]int, 0, p.P)
	infos := make([]*PatchInfo, p.N)
	for s, slot := range slots {
		cursor += int(slot.gap)
		if p.G == 8 && slot.gap == 255 && slot.patch == 0 {
			// 长间隙延续：不修改任何低部，cursor 已累计，留给后续槽。
			pendingGaps = append(pendingGaps, s)
			continue
		}
		if slot.patch == 0 {
			// G<8 不允许 patch=0；G=8 时只有 gap=255 的零槽才是合法延续。
			return nil, d.fail(ErrBadContinuation, "zero-patch non-continuation slot %d", s)
		}
		if cursor >= p.N {
			return nil, d.fail(ErrPatchPosition, "slot %d cursor %d >= N %d", s, cursor, p.N)
		}
		if cursor <= lastPos {
			return nil, d.fail(ErrPatchPosition, "slot %d cursor %d not greater than last patch pos %d", s, cursor, lastPos)
		}

		// 修复：低部 OR (patch << W)。W+PW<=64，结果可放入 uint64。
		lows[cursor] |= slot.patch << uint(p.W)

		gaps := pendingGaps
		pendingGaps = make([]int, 0, p.P)
		infos[cursor] = &PatchInfo{
			Slot: s,
			SlotRange: BitRange{
				Start: slot.start,
				Bits:  uint8(d.f),
			},
			GapSources: gaps,
		}
		lastPos = cursor
	}
	if len(pendingGaps) > 0 {
		return nil, d.fail(ErrBadContinuation, "trailing continuation slots %v without following real patch", pendingGaps)
	}

	// 每个修复后的无符号差值与有符号基值用数学整数相加，严格落在 int64 范围。
	values := make([]Value, p.N)
	for i, low := range lows {
		sum := new(big.Int).Add(baseBig, new(big.Int).SetUint64(low))
		if sum.Cmp(big.NewInt(math.MinInt64)) < 0 || sum.Cmp(big.NewInt(math.MaxInt64)) > 0 {
			return nil, d.fail(ErrOverflow, "value at position %d = %s outside int64", i, sum.String())
		}
		values[i] = Value{
			Value:     sum.Int64(),
			LowRange:  lowRanges[i],
			BaseRange: baseRange,
			Patch:     infos[i],
		}
	}

	return &Result{Base: base, Values: values}, nil
}
