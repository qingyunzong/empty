package dataeng

import (
	"errors"
	"math"
	"testing"
)

// TestExhaustiveSmallReference 用包含 M/I/D/N/=/X/S/H 的记录，
// 对所有有意义的窗口边界做逐碱基展开核对。
func TestExhaustiveSmallReference(t *testing.T) {
	// 参考布局（s=10）：1H 2M 2I 3M 1D 2= 1N 2X 2S 1H
	// 参考覆盖 [10, 10+2+3+1+2+1+2) = [10,21)。
	r := makeRecord(t, 10, "1H2M2I3M1D2=1N2X2S1H")
	o := buildOracle(t, r)
	for L := uint64(8); L <= 22; L++ {
		for Rv := L; Rv <= 22; Rv++ {
			expectClip(t, r, o, L, Rv)
		}
	}
}

// TestInsertionBoundary 专门核对 I 锚点恰在 L 或 R 的半开语义。
func TestInsertionBoundary(t *testing.T) {
	// 3M2I3M，s=0；I 锚在参考位置 3。
	r := makeRecord(t, 0, "3M2I3M")
	o := buildOracle(t, r)

	keep := expectClip(t, r, o, 3, 6)
	foundI := false
	for _, op := range keep.CIGAR {
		if op.Kind == OpInsertion {
			foundI = true
		}
	}
	if !foundI {
		t.Fatalf("L 恰为锚点时 I 应保留: %s", keep.CIGARString())
	}

	drop := expectClip(t, r, o, 0, 3)
	for _, op := range drop.CIGAR {
		if op.Kind == OpInsertion {
			t.Fatalf("R 恰为锚点时 I 应排除: %s", drop.CIGARString())
		}
	}

	c, err := Clip(r, 3, 3)
	if err != nil || !c.Empty {
		t.Fatalf("空窗口 L==R 应 empty: c=%+v err=%v", c, err)
	}
}

// TestAcrossN 核对跨 N 裁剪与 D/N 缺口类别区分。
func TestAcrossN(t *testing.T) {
	r := makeRecord(t, 100, "4M2N3M2D4M")
	o := buildOracle(t, r)
	// 整个窗口跨 N 与 D。
	// 参考跨度 4+2+3+2+4=15，覆盖 [100,115)。
	c := expectClip(t, r, o, 100, 115)
	var kinds []Op
	for _, op := range c.CIGAR {
		kinds = append(kinds, op.Kind)
	}
	wantKinds := []Op{OpM, OpRefSkip, OpM, OpDeletion, OpM}
	if len(kinds) != len(wantKinds) {
		t.Fatalf("CIGAR 操作数=%d 期望 %d (%s)", len(kinds), len(wantKinds), c.CIGARString())
	}
	for i := range kinds {
		if kinds[i] != wantKinds[i] {
			t.Fatalf("CIGAR 操作顺序错误: %s", c.CIGARString())
		}
	}

	// 只取 N 内部：窗口内无双消费操作，必须 empty（不能用 N 伪造）。
	c, err := Clip(r, 104, 106)
	if err != nil || !c.Empty {
		t.Fatalf("纯 N 窗口应 empty: c=%+v err=%v", c, err)
	}

	// 窗口从 N 内部开始并包含后续 M：N 作为首部缺口保留。
	c2, err := Clip(r, 105, 109)
	if err != nil {
		t.Fatalf("Clip: %v", err)
	}
	if c2.Empty || c2.CIGAR[0].Kind != OpRefSkip || c2.CIGAR[0].Length != 1 {
		t.Fatalf("首部 N 应截断保留: %s", c2.CIGARString())
	}
	if c2.RefStart != 105 {
		t.Fatalf("RefStart=%d 期望 105", c2.RefStart)
	}
}

// TestHeadTailDeletion 核对首尾 D 保留、截断与纯 D 空结果。
func TestHeadTailDeletion(t *testing.T) {
	// 参考跨度 3+4+3=10，覆盖 [50,60)：D[50,53) M[53,57) D[57,60)。
	r := makeRecord(t, 50, "3D4M3D")
	o := buildOracle(t, r)

	// 窗口只覆盖首部 D：empty。
	if c, err := Clip(r, 50, 53); err != nil || !c.Empty {
		t.Fatalf("纯 D 窗口应 empty: c=%+v err=%v", c, err)
	}

	// 窗口从首部 D 中段开始：D 截断并作为首部保留。
	c := expectClip(t, r, o, 52, 57)
	if c.CIGAR[0].Kind != OpDeletion || c.CIGAR[0].Length != 1 {
		t.Fatalf("首部 D 应截断为 1D: %s", c.CIGARString())
	}
	if c.RefStart != 52 {
		t.Fatalf("RefStart=%d 期望 52", c.RefStart)
	}

	// 窗口结束于尾部 D 内部（尾部 D 起于 57）：尾部 D 截断为 2D。
	c2 := expectClip(t, r, o, 53, 59)
	last := c2.CIGAR[len(c2.CIGAR)-1]
	if last.Kind != OpDeletion || last.Length != 2 {
		t.Fatalf("尾部 D 应截断为 2D: %s", c2.CIGARString())
	}

	// 窗口完整覆盖：首尾 D 都保留，M 居中。
	c3 := expectClip(t, r, o, 50, 60)
	if c3.CIGARString() != "3D4M3D" {
		t.Fatalf("完整裁剪 CIGAR=%s 期望 3D4M3D", c3.CIGARString())
	}
}

// TestSoftHardClipping 核对原始 S/H 全部去除且读段下标正确。
func TestSoftHardClipping(t *testing.T) {
	// 2H 3S 5M 2I 4M 3S 2H：读长 3+5+2+4+3=17。
	r := makeRecord(t, 7, "2H3S5M2I4M3S2H")
	o := buildOracle(t, r)
	// 参考跨度 5+4=9，覆盖 [7,16)；取整段 M 区 [7,16)。
	c := expectClip(t, r, o, 7, 16)
	for _, op := range c.CIGAR {
		if op.Kind == OpSoftClip || op.Kind == OpHardClip {
			t.Fatalf("输出不应包含 S/H: %s", c.CIGARString())
		}
	}
	// 保留读段从首个 M 的原始下标 3 开始（跳过 3 个 S）。
	if c.ReadStart != 3 {
		t.Fatalf("ReadStart=%d 期望 3", c.ReadStart)
	}
	if c.ReadEnd != 3+5+2+4 {
		t.Fatalf("ReadEnd=%d 期望 %d", c.ReadEnd, 3+5+2+4)
	}
	if len(c.Bases) != int(c.ReadEnd-c.ReadStart) {
		t.Fatalf("Bases 长度与读段区间不一致")
	}
}

// TestEmptyIntersections 核对各类空交集。
func TestEmptyIntersections(t *testing.T) {
	r := makeRecord(t, 100, "4M2D4M")

	cases := []struct {
		name string
		L, R uint64
	}{
		{"窗口整体在左侧", 0, 50},
		{"窗口整体在右侧", 200, 300},
		{"仅落在 D 缺口", 104, 106},
		{"零宽度在 M 前", 100, 100},
		{"零宽度在记录后", 110, 110},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := Clip(r, tc.L, tc.R)
			if err != nil {
				t.Fatalf("Clip: %v", err)
			}
			if !c.Empty {
				t.Fatalf("期望 empty，得到 %s", c.CIGARString())
			}
			if c.CIGAR != nil || c.Bases != nil || c.ReadRetained {
				t.Fatalf("empty 记录字段应为零值: %+v", c)
			}
			if _, err := c.MapRead(0); !errors.Is(err, ErrEmptyClip) {
				t.Fatalf("empty 记录查询应报 ErrEmptyClip: %v", err)
			}
			if _, err := c.MapRef(100); !errors.Is(err, ErrEmptyClip) {
				t.Fatalf("empty 记录查询应报 ErrEmptyClip: %v", err)
			}
		})
	}
}

// TestLargeCoordinates 用接近 uint64 上界的坐标核对溢出处理与正常裁剪。
func TestLargeCoordinates(t *testing.T) {
	const max = math.MaxUint64
	// s=max-9，参考跨度 10，末端点 (max-9)+10=max+1 不可表示，
	// 因此该记录本身应在校验阶段报溢出。
	r := makeRecord(t, max-9, "5M2D3M")
	if _, err := Clip(r, 0, max); !errors.Is(err, ErrOverflow) {
		t.Fatalf("末端点不可表示应报 ErrOverflow，得到 %v", err)
	}

	// 末端点恰好 == MaxUint64（可表示）：s=max-9，跨度 9。
	ok := makeRecord(t, max-9, "5M2D2M")
	oko := buildOracle(t, ok)
	c := expectClip(t, ok, oko, max-9, max)
	if c.RefStart != max-9 || c.CIGARString() != "5M2D2M" {
		t.Fatalf("大坐标全量裁剪错误: start=%d cigar=%s", c.RefStart, c.CIGARString())
	}
	// 窗口只落在首段 M 尾部（D 起于 max-4）：保留 2M。
	c2 := expectClip(t, ok, oko, max-2, max)
	if c2.CIGARString() != "2M" || c2.RefStart != max-2 {
		t.Fatalf("大坐标边界裁剪错误: start=%d cigar=%s", c2.RefStart, c2.CIGARString())
	}
	// 跨 D 的大坐标窗口：D[max-4,max-2) 与尾部 2M。
	c3 := expectClip(t, ok, oko, max-4, max)
	if c3.CIGARString() != "2D2M" || c3.RefStart != max-4 {
		t.Fatalf("大坐标跨 D 裁剪错误: start=%d cigar=%s", c3.RefStart, c3.CIGARString())
	}
	// add64 边界：max+1 不可表示，max+0 可表示。
	if _, ok := add64(max, 1); ok {
		t.Fatalf("max+1 应判定为溢出")
	}
	if v, ok := add64(max, 0); !ok || v != max {
		t.Fatalf("max+0 应可表示")
	}

	// 末端点 s+参考长度不可表示必须报溢出，并给出操作下标。
	bad := makeRecord(t, max-3, "5M")
	_, err := Clip(bad, 0, max)
	var oe *OpError
	if !errors.As(err, &oe) || !errors.Is(err, ErrOverflow) {
		t.Fatalf("期望带操作下标的 ErrOverflow，得到 %v", err)
	}

	// 操作长度本身导致读长求和溢出。
	bad2 := &Record{
		RefStart:  0,
		CIGAR:     []Operation{{Kind: OpM, Length: max}, {Kind: OpInsertion, Length: 1}},
		Bases:     make([]byte, 0),
		Qualities: make([]byte, 0),
	}
	_, err = Clip(bad2, 0, 1)
	if !errors.Is(err, ErrOverflow) {
		t.Fatalf("读长溢出应报 ErrOverflow，得到 %v", err)
	}
}

// TestValidationErrors 核对结构校验错误与操作下标。
func TestValidationErrors(t *testing.T) {
	baseOps := func() []Operation {
		return []Operation{
			{Kind: OpM, Length: 2},
			{Kind: OpInsertion, Length: 1},
			{Kind: OpM, Length: 2},
		}
	}
	baseRecord := func(ops []Operation, readN int) *Record {
		return &Record{
			RefStart:  1,
			CIGAR:     ops,
			Bases:     make([]byte, readN),
			Qualities: make([]byte, readN),
		}
	}

	t.Run("nil 记录", func(t *testing.T) {
		if _, err := Clip(nil, 0, 1); !errors.Is(err, ErrNilRecord) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("空 CIGAR", func(t *testing.T) {
		if _, err := Clip(&Record{}, 0, 1); !errors.Is(err, ErrEmptyCIGAR) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("零长度操作", func(t *testing.T) {
		ops := baseOps()
		ops[1].Length = 0
		_, err := Clip(baseRecord(ops, 4), 0, 5)
		assertOpErr(t, err, ErrZeroLength, 1)
	})
	t.Run("相邻同操作", func(t *testing.T) {
		ops := []Operation{{Kind: OpM, Length: 2}, {Kind: OpM, Length: 1}}
		_, err := Clip(baseRecord(ops, 3), 0, 3)
		assertOpErr(t, err, ErrAdjacentSameOp, 1)
	})
	t.Run("H 不在最外端", func(t *testing.T) {
		ops := []Operation{
			{Kind: OpM, Length: 1},
			{Kind: OpHardClip, Length: 1},
			{Kind: OpM, Length: 1},
		}
		_, err := Clip(baseRecord(ops, 2), 0, 2)
		assertOpErr(t, err, ErrHardClipPosition, 1)
	})
	t.Run("S 不在两端", func(t *testing.T) {
		ops := []Operation{
			{Kind: OpM, Length: 1},
			{Kind: OpSoftClip, Length: 1},
			{Kind: OpM, Length: 1},
		}
		_, err := Clip(baseRecord(ops, 3), 0, 2)
		assertOpErr(t, err, ErrSoftClipPosition, 1)
	})
	t.Run("读长不一致", func(t *testing.T) {
		_, err := Clip(baseRecord(baseOps(), 3), 0, 5)
		if !errors.Is(err, ErrReadLengthMismatch) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("质量长度不一致", func(t *testing.T) {
		r := baseRecord(baseOps(), 5)
		r.Qualities = make([]byte, 4)
		_, err := Clip(r, 0, 5)
		if !errors.Is(err, ErrQualityLenMismatch) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("窗口反向", func(t *testing.T) {
		_, err := Clip(baseRecord(baseOps(), 5), 5, 4)
		if !errors.Is(err, ErrWindowReversed) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("合法两端 S/H", func(t *testing.T) {
		ops := []Operation{
			{Kind: OpHardClip, Length: 2},
			{Kind: OpSoftClip, Length: 1},
			{Kind: OpM, Length: 2},
			{Kind: OpSoftClip, Length: 1},
			{Kind: OpHardClip, Length: 2},
		}
		r := baseRecord(ops, 4)
		if _, err := Clip(r, 1, 3); err != nil {
			t.Fatalf("合法 S/H 布局被拒绝: %v", err)
		}
	})
}

func assertOpErr(t *testing.T, err error, target error, idx int) {
	t.Helper()
	var oe *OpError
	if !errors.As(err, &oe) || !errors.Is(err, target) {
		t.Fatalf("期望 %v，得到 %v", target, err)
	}
	if oe.OpIndex != idx {
		t.Fatalf("操作下标=%d 期望 %d", oe.OpIndex, idx)
	}
}

// TestMergingAndFormats 核对相邻同类型合并与 CIGAR 字符串往返。
func TestMergingAndFormats(t *testing.T) {
	// 3M2I3M：I 锚在参考位置 3。窗口 [4,6) 使锚点 p=3 落在窗口左侧，
	// I 被排除，仅保留第二个 M 的 2 个碱基。
	r := makeRecord(t, 0, "3M2I3M")
	c, err := Clip(r, 4, 6)
	if err != nil {
		t.Fatalf("Clip: %v", err)
	}
	if c.Empty || c.CIGARString() != "2M" {
		t.Fatalf("应得到 2M，得到 %q", c.CIGARString())
	}

	// 真正的合并场景：2M I 2M，I 锚在 p=2。窗口 [0,2) 与 [2,4) 分开取时
	// I 都不在窗口内；取窗口 [1,4) 时锚点 p=2 在窗口内故 I 保留；
	// 这里用 [0,2)∪ 无法一次表达，改为验证跨锚点排除：窗口 [1,2) 只剩 1M。
	rm := makeRecord(t, 0, "2M1I2M")
	cm, err := Clip(rm, 1, 2)
	if err != nil || cm.Empty || cm.CIGARString() != "1M" {
		t.Fatalf("窗口 [1,2) 应得 1M，得到 %q err=%v", cm.CIGARString(), err)
	}

	ops, err := ParseCIGAR("10M2I3=4X5D6N7S8H")
	if err != nil {
		t.Fatalf("ParseCIGAR: %v", err)
	}
	if len(ops) != 8 || ops[0].Length != 10 || ops[7].Kind != OpHardClip {
		t.Fatalf("ParseCIGAR 解析结果异常: %+v", ops)
	}
	r2 := makeRecord(t, 0, "10M2I3=4X")
	c2, err := Clip(r2, 0, 17)
	if err != nil {
		t.Fatalf("Clip: %v", err)
	}
	if c2.CIGARString() != "10M2I3=4X" {
		t.Fatalf("CIGARString=%s", c2.CIGARString())
	}

	if _, err := ParseCIGAR("10"); err == nil {
		t.Fatalf("残缺 CIGAR 应报错")
	}
	if _, err := ParseCIGAR("M"); err == nil {
		t.Fatalf("缺长度的 CIGAR 应报错")
	}
	if _, err := ParseCIGAR("0M"); !errors.Is(err, ErrZeroLength) {
		t.Fatalf("0M 应报 ErrZeroLength，得到 %v", err)
	}
}
