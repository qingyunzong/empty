package patchedbase

import (
	"errors"
	"math"
	"math/big"
	"testing"
)

// ---------------------------------------------------------------------------
// 独立编码构造：与生产代码完全分开的 MSB-first 位打包器，仅用于测试造数。
// ---------------------------------------------------------------------------

type bitWriter struct {
	buf []byte
	pos int
}

func (w *bitWriter) write(v uint64, bits int) {
	for i := bits - 1; i >= 0; i-- {
		if w.pos>>3 >= len(w.buf) {
			w.buf = append(w.buf, 0)
		}
		bit := int((v>>uint(i))&1) << uint(7-w.pos&7)
		w.buf[w.pos>>3] |= byte(bit)
		w.pos++
	}
}

// padToByte 推进到下一字节边界；缓冲区从零分配，填充位天然为 0。
func (w *bitWriter) padToByte() {
	for w.pos&7 != 0 {
		w.write(0, 1)
	}
}

type slotSpec struct {
	gap   uint64
	patch uint64
}

func paramsOf(n, w, bw, pw, g, p int) Params {
	f := slotWidth(g + pw)
	length := bw + (n*w+7)/8 + (p*f+7)/8
	return Params{N: n, W: w, BW: bw, PW: pw, G: g, P: p, BodyLength: length}
}

// signMagBytes 按“最高位符号 + 绝对值”规则构造基值字节。
func signMagBytes(base int64, bw int) []byte {
	out := make([]byte, bw)
	if base < 0 {
		mag := new(big.Int).Neg(big.NewInt(base)) // MinInt64 也能精确表示
		mag.SetBit(mag, bw*8-1, 1)
		fill := mag.FillBytes(out)
		return fill
	}
	mag := big.NewInt(base)
	return mag.FillBytes(out)
}

// flipBit 在已编码体中翻转指定绝对位，索引超出体长度时跳过（用于越界造错保护）。
func flipBit(body []byte, bit int) []byte {
	if bit < 0 || bit>>3 >= len(body) {
		return body
	}
	body[bit>>3] |= 1 << uint(7-bit&7)
	return body
}

func buildBody(p Params, baseRaw []byte, lows []uint64, slots []slotSpec) []byte {
	f := slotWidth(p.G + p.PW)
	var w bitWriter
	for _, b := range baseRaw {
		w.write(uint64(b), 8)
	}
	for _, low := range lows {
		w.write(low, p.W)
	}
	w.padToByte()
	for _, s := range slots {
		w.write((s.gap<<uint(p.PW))|s.patch, f)
	}
	w.padToByte()
	return w.buf
}

// ---------------------------------------------------------------------------
// 逐位数学整数参考实现：逐位用 big.Int 拼装，独立于生产代码的 uint64 路径。
// 只用于成功用例，对规则做平行验证。
// ---------------------------------------------------------------------------

type refReader struct {
	body []byte
	pos  int
}

func (r *refReader) read(bits int) *big.Int {
	x := new(big.Int)
	for i := 0; i < bits; i++ {
		bit := uint((r.body[r.pos>>3] >> (7 - uint(r.pos&7))) & 1)
		x.Lsh(x, 1).Or(x, big.NewInt(int64(bit)))
		r.pos++
	}
	return x
}

func (r *refReader) skipPadding() {
	for r.pos&7 != 0 {
		r.pos++
	}
}

func referenceDecode(p Params, body []byte) (int64, []int64) {
	r := &refReader{body: body}
	rawBase := r.read(p.BW * 8)
	magMask := new(big.Int).Sub(
		new(big.Int).Lsh(big.NewInt(1), uint(p.BW*8-1)),
		big.NewInt(1),
	)
	sign := rawBase.Bit(p.BW*8 - 1)
	mag := new(big.Int).And(rawBase, magMask)
	baseBig := new(big.Int).Set(mag)
	if sign == 1 {
		baseBig.Neg(baseBig)
	}

	lows := make([]*big.Int, p.N)
	for i := range lows {
		lows[i] = r.read(p.W)
	}
	r.skipPadding()

	f := slotWidth(p.G + p.PW)
	patchMask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(p.PW)), big.NewInt(1))
	cursor := 0
	for s := 0; s < p.P; s++ {
		raw := r.read(f)
		patch := new(big.Int).And(raw, patchMask)
		gap := int(new(big.Int).Rsh(raw, uint(p.PW)).Int64())
		cursor += gap
		if p.G == 8 && gap == 255 && patch.Sign() == 0 {
			continue
		}
		repaired := new(big.Int).Lsh(patch, uint(p.W))
		lows[cursor].Or(lows[cursor], repaired)
	}

	values := make([]int64, p.N)
	for i, low := range lows {
		values[i] = new(big.Int).Add(baseBig, low).Int64()
	}
	return baseBig.Int64(), values
}

// ---------------------------------------------------------------------------
// 解码用例
// ---------------------------------------------------------------------------

type wantPatch struct {
	slot int
	gaps []int
}

type decodeCase struct {
	name       string
	params     Params
	base       int64
	baseRaw    []byte // 为空时按 base 生成
	lows       []uint64
	slots      []slotSpec
	flips      []int  // 造错：把绝对位序号处的 0 填充/保留位翻成 1
	truncate   int    // 丢弃尾部字节数
	extra      []byte // 追加的额外字节
	wantKind   Kind
	wantValues []int64
	wantPatch  map[int]wantPatch
}

func (c decodeCase) encoded() []byte {
	raw := c.baseRaw
	if raw == nil {
		raw = signMagBytes(c.base, c.params.BW)
	}
	body := buildBody(c.params, raw, c.lows, c.slots)
	for _, bit := range c.flips {
		body = flipBit(body, bit)
	}
	if c.truncate > 0 {
		body = body[:len(body)-c.truncate]
	}
	return append(body, c.extra...)
}

func decodeCases() []decodeCase {
	return []decodeCase{
		{
			// 0xFF 按符号-绝对值是 -127，而非二补码的 -1。
			name:       "sign-magnitude differs from twos-complement",
			params:     paramsOf(3, 5, 1, 5, 1, 1),
			baseRaw:    []byte{0xFF},
			lows:       []uint64{1, 2, 3},
			slots:      []slotSpec{{gap: 1, patch: 1}},
			wantKind:   KindOK,
			wantValues: []int64{-126, -93, -124},
			wantPatch:  map[int]wantPatch{1: {slot: 0}},
		},
		{
			// 负零 0x8000 按 0 接受。
			name:       "negative zero accepted as zero",
			params:     paramsOf(2, 4, 2, 4, 2, 1),
			baseRaw:    []byte{0x80, 0x00},
			lows:       []uint64{10, 5},
			slots:      []slotSpec{{gap: 0, patch: 2}},
			wantKind:   KindOK,
			wantValues: []int64{42, 5},
			wantPatch:  map[int]wantPatch{0: {slot: 0}},
		},
		{
			// 首个真补丁允许落在位置 0；随后 gap=1 连续真补丁。
			name:   "position zero and consecutive gap-one patches",
			params: paramsOf(4, 3, 1, 3, 3, 2),
			base:   5,
			lows:   []uint64{0, 1, 2, 3},
			slots: []slotSpec{
				{gap: 0, patch: 1},
				{gap: 1, patch: 1},
			},
			wantKind:   KindOK,
			wantValues: []int64{13, 14, 7, 8},
			wantPatch: map[int]wantPatch{
				0: {slot: 0},
				1: {slot: 1},
			},
		},
		{
			name:   "three consecutive real patches gap one",
			params: paramsOf(4, 4, 1, 4, 4, 3),
			lows:   []uint64{0, 0, 0, 0},
			slots: []slotSpec{
				{gap: 1, patch: 1},
				{gap: 1, patch: 1},
				{gap: 1, patch: 1},
			},
			wantKind:   KindOK,
			wantValues: []int64{0, 16, 16, 16},
			wantPatch: map[int]wantPatch{
				1: {slot: 0},
				2: {slot: 1},
				3: {slot: 2},
			},
		},
		{
			// 255 长间隙延续：cursor 累计 255 后再 +1，真补丁落在 256。
			name:       "255 long-gap continuation",
			params:     paramsOf(257, 1, 1, 8, 8, 2),
			lows:       make([]uint64, 257),
			slots:      []slotSpec{{gap: 255, patch: 0}, {gap: 1, patch: 1}},
			wantKind:   KindOK,
			wantValues: append(make([]int64, 256), 2),
			wantPatch:  map[int]wantPatch{256: {slot: 1, gaps: []int{0}}},
		},
		{
			// 两个延续槽连用得到 510 间隙，再 +1 落在 511。
			name:   "510 gap via two chained continuations",
			params: paramsOf(512, 1, 1, 8, 8, 3),
			lows:   make([]uint64, 512),
			slots: []slotSpec{
				{gap: 255, patch: 0},
				{gap: 255, patch: 0},
				{gap: 1, patch: 1},
			},
			wantKind:   KindOK,
			wantValues: append(make([]int64, 511), 2),
			wantPatch: map[int]wantPatch{
				511: {slot: 2, gaps: []int{0, 1}},
			},
		},
		{
			// 真补丁之间夹延续槽，间隙来源归并到各自的后继补丁。
			name:   "continuations interspersed between real patches",
			params: paramsOf(512, 1, 1, 8, 8, 4),
			lows:   make([]uint64, 512),
			slots: []slotSpec{
				{gap: 255, patch: 0},
				{gap: 1, patch: 1},
				{gap: 255, patch: 0},
				{gap: 0, patch: 1},
			},
			wantKind: KindOK,
			wantValues: func() []int64 {
				values := make([]int64, 512)
				values[256], values[511] = 2, 2
				return values
			}(),
			wantPatch: map[int]wantPatch{
				256: {slot: 1, gaps: []int{0}},
				511: {slot: 3, gaps: []int{2}},
			},
		},
		{
			// 唯一的槽是延续，没有后继真补丁。
			name:     "trailing continuation without any real patch",
			params:   paramsOf(4, 1, 1, 1, 8, 1),
			lows:     []uint64{0, 0, 0, 0},
			slots:    []slotSpec{{gap: 255, patch: 0}},
			wantKind: KindBadContinuation,
		},
		{
			// 真补丁之后以延续槽收尾。
			name:   "trailing continuation after a real patch",
			params: paramsOf(10, 1, 1, 1, 8, 2),
			lows:   make([]uint64, 10),
			slots: []slotSpec{
				{gap: 1, patch: 1},
				{gap: 255, patch: 0},
			},
			wantKind: KindBadContinuation,
		},
		{
			name:       "P equals zero no slots",
			params:     paramsOf(4, 7, 1, 8, 8, 0),
			base:       10,
			lows:       []uint64{1, 2, 3, 127},
			wantKind:   KindOK,
			wantValues: []int64{11, 12, 13, 137},
		},
		{
			// 修复结果恰好为 int64 最大值。
			name:       "reconstructed value exactly int64 max",
			params:     paramsOf(1, 4, 8, 4, 4, 0),
			base:       math.MaxInt64 - 3,
			lows:       []uint64{3},
			wantKind:   KindOK,
			wantValues: []int64{math.MaxInt64},
		},
		{
			// 最小可表示负基值：符号位置位 + 最大绝对值 2^63-1。
			// 原始字节全 0xFF 按符号-绝对值是 -(2^63-1)，而二补码会读作 -1。
			name:       "minimum representable negative base",
			params:     paramsOf(1, 1, 8, 1, 1, 0),
			baseRaw:    []byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF},
			lows:       []uint64{0},
			wantKind:   KindOK,
			wantValues: []int64{math.MinInt64 + 1},
		},
		{
			// 正向越界：base + 低部 > int64 最大值，禁止回绕。
			name:       "positive overflow above int64 max",
			params:     paramsOf(1, 4, 8, 4, 4, 0),
			base:       math.MaxInt64,
			lows:       []uint64{1},
			wantKind:   KindOverflow,
			wantValues: nil,
		},
		{
			// 两段均非字节对齐：W=3（12 位后补 4 位），F=8 槽 2 个（16 位对齐）。
			name:   "non-byte-aligned low and slot segments",
			params: paramsOf(4, 3, 1, 4, 4, 2),
			base:   100,
			lows:   []uint64{1, 2, 3, 4},
			slots: []slotSpec{
				{gap: 0, patch: 5},
				{gap: 1, patch: 6},
			},
			wantKind:   KindOK,
			wantValues: []int64{141, 150, 103, 104},
			wantPatch: map[int]wantPatch{
				0: {slot: 0},
				1: {slot: 1},
			},
		},
		{
			// G+PW=13，F 向上取整到 16；第 16 位（保留高位）必须为 0。
			name:   "reserved high bits above F minus G plus PW must be zero",
			params: paramsOf(4, 3, 1, 9, 8, 1),
			base:   0,
			lows:   []uint64{0, 0, 0, 0},
			slots:  []slotSpec{{gap: 1, patch: 7}},
			// base 8 位 + 低部 12 位 + 补 4 位 = 24 位；槽从位 24 开始，
			// G+PW=17 -> F=18，保留高位是槽内第 17 位（0 起），即绝对位 24+17=41。
			flips:    []int{41},
			wantKind: KindPadding,
		},
		{
			// 低部段尾填充位非 0：N*W=12，位 20..23 是填充，翻位 20。
			name:     "nonzero low-part tail padding rejected",
			params:   paramsOf(4, 3, 1, 4, 4, 1),
			base:     0,
			lows:     []uint64{1, 2, 3, 4},
			slots:    []slotSpec{{gap: 1, patch: 1}},
			flips:    []int{20},
			wantKind: KindPadding,
		},
		{
			// 补丁段尾填充非 0：F=8、P=1 槽后无填充，改用 F=16、P=1 造填充位。
			name:     "nonzero slot-segment tail padding rejected",
			params:   paramsOf(2, 3, 1, 8, 5, 1),
			base:     0,
			lows:     []uint64{0, 0},
			slots:    []slotSpec{{gap: 1, patch: 1}},
			flips:    []int{29}, // base8+低部6+补2=16；F=13 槽16..28，补位 29..31
			wantKind: KindPadding,
		},
		{
			// 真补丁位置重复：两个槽 cursor 都到位置 2。
			name:   "duplicate real patch position rejected",
			params: paramsOf(6, 2, 1, 2, 3, 2),
			base:   0,
			lows:   []uint64{0, 0, 0, 0, 0, 0},
			slots: []slotSpec{
				{gap: 2, patch: 1},
				{gap: 0, patch: 1},
			},
			wantKind: KindPatchPosition,
		},
		{
			// cursor 越过 N：gap 直接到 N。
			name:     "patch position beyond N rejected",
			params:   paramsOf(3, 2, 1, 2, 4, 1),
			base:     0,
			lows:     []uint64{0, 0, 0},
			slots:    []slotSpec{{gap: 3, patch: 1}},
			wantKind: KindPatchPosition,
		},
		{
			// G<8 时 patch=0 不能冒充延续。
			name:     "zero patch with G below eight is illegal continuation",
			params:   paramsOf(4, 2, 1, 2, 4, 1),
			base:     0,
			lows:     []uint64{0, 0, 0, 0},
			slots:    []slotSpec{{gap: 1, patch: 0}},
			wantKind: KindBadContinuation,
		},
		{
			// G=8 但 gap 非 255 的零槽也不是延续。
			name:     "zero patch with gap other than 255 is illegal",
			params:   paramsOf(4, 2, 1, 2, 8, 1),
			base:     0,
			lows:     []uint64{0, 0, 0, 0},
			slots:    []slotSpec{{gap: 254, patch: 0}},
			wantKind: KindBadContinuation,
		},
		{
			name:     "truncated body rejected",
			params:   paramsOf(4, 3, 1, 4, 4, 2),
			base:     1,
			lows:     []uint64{1, 2, 3, 4},
			slots:    []slotSpec{{gap: 1, patch: 1}, {gap: 1, patch: 1}},
			truncate: 1,
			wantKind: KindTruncated,
		},
		{
			name:     "extra bytes beyond declared length rejected",
			params:   paramsOf(3, 5, 1, 5, 1, 1),
			base:     0,
			lows:     []uint64{1, 2, 3},
			slots:    []slotSpec{{gap: 1, patch: 1}},
			extra:    []byte{0xAA, 0xBB},
			wantKind: KindExtraBytes,
		},
	}
}

func kindOf(err error) Kind {
	var pe *Error
	if errors.As(err, &pe) {
		return pe.Kind
	}
	return KindOK
}

// runChunked 在 body 的每一个切点切块，必要时附带额外字节，逐块 Push。
func runChunked(t *testing.T, p Params, body []byte, cut int) (*Result, error) {
	t.Helper()
	d, err := New(p)
	if err != nil {
		return nil, err
	}
	declared := p.BodyLength
	if cut > declared {
		cut = declared
	}
	if cut > 0 {
		if err := d.Push(body[:cut]); err != nil {
			return nil, err
		}
	}
	if cut < len(body) {
		if err := d.Push(body[cut:]); err != nil {
			return nil, err
		}
	}
	return d.Finish()
}

func TestDecoderAllCutPoints(t *testing.T) {
	for _, tc := range decodeCases() {
		tc := tc
		body := tc.encoded()
		// 对声明体长的每一个字节边界都做一次切块，外加 0 字节首块。
		cuts := len(body)
		if tc.wantKind == KindOK && cuts > tc.params.BodyLength {
			cuts = tc.params.BodyLength
		}
		for cut := 0; cut <= cuts; cut++ {
			t.Run(tc.name+"_cut_"+itoa(cut), func(t *testing.T) {
				res, err := runChunked(t, tc.params, body, cut)
				if kindOf(err) != tc.wantKind {
					t.Fatalf("cut=%d kind = %v, want %v (err=%v)", cut, kindOf(err), tc.wantKind, err)
				}
				if tc.wantKind != KindOK {
					if res != nil {
						t.Fatalf("cut=%d failed decode returned non-nil result", cut)
					}
					return
				}
				if res == nil || len(res.Values) != tc.params.N {
					t.Fatalf("cut=%d bad result: %#v", cut, res)
				}
				for i, want := range tc.wantValues {
					if res.Values[i].Value != want {
						t.Fatalf("cut=%d value[%d] = %d, want %d", cut, i, res.Values[i].Value, want)
					}
				}
				verifyRangesAndPatches(t, tc, res)
				// 成功用例与逐位 big.Int 参考实现交叉核对。
				refBase, refValues := referenceDecode(tc.params, body[:tc.params.BodyLength])
				if refBase != res.Base {
					t.Fatalf("cut=%d base = %d, reference %d", cut, res.Base, refBase)
				}
				for i := range refValues {
					if refValues[i] != res.Values[i].Value {
						t.Fatalf("cut=%d reference mismatch at %d: %d vs %d", cut, i, refValues[i], res.Values[i].Value)
					}
				}
			})
		}
	}
}

func verifyRangesAndPatches(t *testing.T, tc decodeCase, res *Result) {
	t.Helper()
	baseBits := tc.params.BW * 8
	for i, v := range res.Values {
		if v.BaseRange != (BitRange{Start: 0, Bits: uint8(baseBits)}) {
			t.Fatalf("value %d base range %#v", i, v.BaseRange)
		}
		wantLowStart := uint64(baseBits + i*tc.params.W)
		if v.LowRange != (BitRange{Start: wantLowStart, Bits: uint8(tc.params.W)}) {
			t.Fatalf("value %d low range = %#v, want start %d bits %d", i, v.LowRange, wantLowStart, tc.params.W)
		}
		wp, patched := tc.wantPatch[i]
		if !patched {
			if v.Patch != nil {
				t.Fatalf("value %d unexpectedly patched: %#v", i, v.Patch)
			}
			continue
		}
		if v.Patch == nil {
			t.Fatalf("value %d missing patch info", i)
		}
		if v.Patch.Slot != wp.slot {
			t.Fatalf("value %d slot = %d, want %d", i, v.Patch.Slot, wp.slot)
		}
		if len(v.Patch.GapSources) != len(wp.gaps) {
			t.Fatalf("value %d gap sources = %v, want %v", i, v.Patch.GapSources, wp.gaps)
		}
		for j, g := range wp.gaps {
			if v.Patch.GapSources[j] != g {
				t.Fatalf("value %d gap source %d = %d, want %d", i, j, v.Patch.GapSources[j], g)
			}
		}
		slotStart := uint64(tc.params.BW * 8)
		slotStart = (slotStart + uint64(tc.params.N*tc.params.W) + 7) &^ 7
		slotStart += uint64(wp.slot * slotWidth(tc.params.G+tc.params.PW))
		if v.Patch.SlotRange != (BitRange{Start: slotStart, Bits: uint8(slotWidth(tc.params.G + tc.params.PW))}) {
			t.Fatalf("value %d slot range = %#v, want start %d", i, v.Patch.SlotRange, slotStart)
		}
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [24]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}

func TestParameterValidation(t *testing.T) {
	good := paramsOf(4, 8, 2, 8, 8, 1)
	cases := []struct {
		name   string
		mutate func(Params) Params
	}{
		{"N zero", func(p Params) Params { p.N = 0; return p }},
		{"N too large", func(p Params) Params { p.N = 513; return p }},
		{"W not in set 25", func(p Params) Params { p.W = 25; return p }},
		{"W not in set 27", func(p Params) Params { p.W = 27; return p }},
		{"W zero", func(p Params) Params { p.W = 0; return p }},
		{"PW not in set", func(p Params) Params { p.PW = 25; return p }},
		{"BW zero", func(p Params) Params { p.BW = 0; return p }},
		{"BW nine", func(p Params) Params { p.BW = 9; return p }},
		{"G zero", func(p Params) Params { p.G = 0; return p }},
		{"G nine", func(p Params) Params { p.G = 9; return p }},
		{"P negative", func(p Params) Params { p.P = -1; return p }},
		{"P thirty two", func(p Params) Params { p.P = 32; return p }},
		{"W plus PW over 64", func(p Params) Params { p.W = 32; p.PW = 40; return p }},
		{"G plus PW over 64", func(p Params) Params { p.G = 8; p.PW = 64; return p }},
		{"body length mismatch", func(p Params) Params { p.BodyLength++; return p }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := tc.mutate(good)
			if _, err := New(p); kindOf(err) != KindInvalidParameter {
				t.Fatalf("err = %v, want KindInvalidParameter", err)
			}
		})
	}
	if _, err := New(good); err != nil {
		t.Fatalf("valid params rejected: %v", err)
	}
}

func TestFailureStateMachine(t *testing.T) {
	tc := decodeCases()[0] // 成功用例做对照
	body := tc.encoded()

	// 失败后不可继续 Push，重复 Finish 返回同一类别错误。
	bad := decodeCases()[len(decodeCases())-2] // truncated
	badBody := bad.encoded()
	d, err := New(bad.params)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Push(badBody); err != nil {
		t.Fatalf("push before finish should not fail: %v", err)
	}
	if _, err := d.Finish(); kindOf(err) != KindTruncated {
		t.Fatalf("finish kind = %v, want truncated", kindOf(err))
	}
	if err := d.Push([]byte{1, 2, 3}); kindOf(err) != KindTruncated {
		t.Fatalf("push after failure kind = %v, want truncated", kindOf(err))
	}
	if _, err := d.Finish(); kindOf(err) != KindTruncated {
		t.Fatalf("second finish kind = %v, want truncated", kindOf(err))
	}

	// 成功交付一次后，再 Finish 或 Push 都是状态错误。
	ok, err := New(tc.params)
	if err != nil {
		t.Fatal(err)
	}
	if err := ok.Push(body); err != nil {
		t.Fatal(err)
	}
	res, err := ok.Finish()
	if err != nil {
		t.Fatalf("first finish: %v", err)
	}
	if res == nil {
		t.Fatal("nil result on success")
	}
	if _, err := ok.Finish(); kindOf(err) != KindState {
		t.Fatalf("repeat finish kind = %v, want state", kindOf(err))
	}
	if err := ok.Push([]byte{0}); kindOf(err) != KindState {
		t.Fatalf("push after success kind = %v, want state", kindOf(err))
	}
}

func TestSlotWidthRounding(t *testing.T) {
	cases := map[int]int{
		2:  2,
		13: 13, // 1..24 全部在集合内，无需取整
		25: 26,
		27: 28,
		29: 30,
		31: 32,
		33: 40,
		41: 48,
		49: 56,
		57: 64,
		65: 0,
	}
	for need, want := range cases {
		if got := slotWidth(need); got != want {
			t.Fatalf("slotWidth(%d) = %d, want %d", need, got, want)
		}
	}
}

func TestMultiChunkAndEmptyPushes(t *testing.T) {
	tc := decodeCases()[0]
	body := tc.encoded()
	d, err := New(tc.params)
	if err != nil {
		t.Fatal(err)
	}
	// 每字节一次 Push，并夹杂空切块。
	for i := 0; i < len(body); i++ {
		if err := d.Push(nil); err != nil {
			t.Fatalf("empty push %d: %v", i, err)
		}
		if err := d.Push(body[i : i+1]); err != nil {
			t.Fatalf("byte push %d: %v", i, err)
		}
	}
	res, err := d.Finish()
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	for i, want := range tc.wantValues {
		if res.Values[i].Value != want {
			t.Fatalf("value[%d] = %d, want %d", i, res.Values[i].Value, want)
		}
	}
}

func TestBoundedAllocation(t *testing.T) {
	// 声明体长伪造也不会触发超界分配：New 以计算体长为准并直接拒绝。
	p := Params{N: 512, W: 64, BW: 8, PW: 64, G: 8, P: 31, BodyLength: 1 << 30}
	if _, err := New(p); kindOf(err) != KindInvalidParameter {
		t.Fatalf("huge declared length kind = %v, want invalid parameter", kindOf(err))
	}
}

func TestEdgeWidthsAndSentinels(t *testing.T) {
	t.Run("negative zero with BW eight", func(t *testing.T) {
		p := paramsOf(2, 56, 8, 8, 8, 0)
		p.BodyLength = 8 + (2*56+7)/8
		maxLow := uint64(1)<<56 - 1
		body := buildBody(p, signMagBytes(0, 8), []uint64{1, maxLow}, nil)
		d, err := New(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := d.Push(body); err != nil {
			t.Fatal(err)
		}
		res, err := d.Finish()
		if err != nil {
			t.Fatalf("finish: %v", err)
		}
		if res.Base != 0 {
			t.Fatalf("base = %d, want 0 (negative zero)", res.Base)
		}
		if res.Values[0].Value != 1 || res.Values[1].Value != int64(maxLow) {
			t.Fatalf("values = %d,%d", res.Values[0].Value, res.Values[1].Value)
		}
	})

	t.Run("W64 patch OR and sentinel errors", func(t *testing.T) {
		p := paramsOf(2, 64, 1, 1, 1, 1) // W+PW=65 非法，先验证哨兵
		if _, err := New(p); !errors.Is(err, ErrInvalidParameter) {
			t.Fatalf("err = %v, errors.Is ErrInvalidParameter = false", err)
		}

		// 合法高位组合：W=56、PW=8（W+PW=64），F=9（集合中下一个允许宽度）。
		ok := paramsOf(2, 56, 1, 8, 1, 1)
		body := buildBody(ok, signMagBytes(0, 1), []uint64{1, 0}, []slotSpec{{gap: 1, patch: 1}})
		d, err := New(ok)
		if err != nil {
			t.Fatal(err)
		}
		if err := d.Push(body); err != nil {
			t.Fatal(err)
		}
		res, err := d.Finish()
		if err != nil {
			t.Fatalf("finish: %v", err)
		}
		// 位置 1：低部 0 OR (1<<56)。
		var wantPatched int64 = 1 << 56
		if res.Values[1].Value != wantPatched {
			t.Fatalf("patched value = %d, want %d", res.Values[1].Value, wantPatched)
		}
		if res.Values[1].Patch == nil || res.Values[1].Patch.Slot != 0 {
			t.Fatalf("patch info missing: %#v", res.Values[1].Patch)
		}
	})

	t.Run("strictly increasing positions after continuations", func(t *testing.T) {
		// 延续累计 255 后真补丁在 256；下一槽 gap=0 想落回 256，必须拒绝。
		p := paramsOf(300, 1, 1, 8, 8, 3)
		body := buildBody(p, signMagBytes(0, 1), make([]uint64, 300), []slotSpec{
			{gap: 255, patch: 0},
			{gap: 1, patch: 1},
			{gap: 0, patch: 1},
		})
		d, err := New(p)
		if err != nil {
			t.Fatal(err)
		}
		_ = d.Push(body)
		if _, err := d.Finish(); !errors.Is(err, ErrPatchPosition) {
			t.Fatalf("err = %v, want ErrPatchPosition", err)
		}
	})
}
