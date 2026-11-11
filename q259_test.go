package q259

import (
	"errors"
	"image"
	"sync"
	"testing"
)

// rleRow 把若干 (count,index) 游程编码成一行，自动补行结束标记 0。
func rleRow(runs ...[2]byte) []byte {
	buf := make([]byte, 0, len(runs)*2+1)
	for _, r := range runs {
		buf = append(buf, r[0], r[1])
	}
	return append(buf, 0)
}

// encodeObject 生成带 4 字节尺寸头的完整对象定义。
func encodeObject(width, height int, rle []byte) []byte {
	buf := make([]byte, 4+len(rle))
	buf[0] = byte(width >> 8)
	buf[1] = byte(width)
	buf[2] = byte(height >> 8)
	buf[3] = byte(height)
	copy(buf[4:], rle)
	return buf
}

// splitFragments 把完整定义按 chunkSize 切成带偏移的分片序列。
func splitFragments(id uint16, version uint32, def []byte, chunkSize int) []ObjectFragment {
	if chunkSize <= 0 {
		chunkSize = 1
	}
	var out []ObjectFragment
	for off := 0; off < len(def); off += chunkSize {
		end := off + chunkSize
		if end > len(def) {
			end = len(def)
		}
		out = append(out, ObjectFragment{
			ID:          id,
			Version:     version,
			TotalLength: uint32(len(def)),
			Offset:      uint32(off),
			Data:        append([]byte(nil), def[off:end]...),
		})
	}
	return out
}

func paletteV1() *Palette {
	p := NewPalette(1)
	p.TransparentIndex = 0
	p.Entries[1] = Color{R: 255, A: 255} // 红
	p.Entries[2] = Color{G: 255, A: 255} // 绿
	return p
}

func mustAdd(t *testing.T, d *Decoder, f ObjectFragment) {
	t.Helper()
	if err := d.AddObject(f); err != nil {
		t.Fatalf("AddObject: %v", err)
	}
}

func pixelAt(img *image.RGBA, x, y int) Color {
	off := (y-img.Rect.Min.Y)*img.Stride + (x-img.Rect.Min.X)*4
	return Color{R: img.Pix[off], G: img.Pix[off+1], B: img.Pix[off+2], A: img.Pix[off+3]}
}

// 基础合成：对象放到 (1,1)，透明索引保留底图，画布为预乘 RGBA。
func TestBasicComposition(t *testing.T) {
	d := NewDecoder()
	rle := append(
		rleRow([2]byte{2, 1}, [2]byte{1, 0}),
		rleRow([2]byte{1, 0}, [2]byte{2, 2})...,
	)
	def := encodeObject(3, 2, rle)
	for _, f := range splitFragments(7, 1, def, 2) {
		mustAdd(t, d, f)
	}
	if err := d.AddPalette(paletteV1()); err != nil {
		t.Fatal(err)
	}
	if err := d.SetDisplayList(&DisplayList{
		Width: 4, Height: 4,
		Objects: []DisplayObject{{ObjectID: 7, ObjectVersion: 1, PaletteVersion: 1, X: 1, Y: 1}},
	}); err != nil {
		t.Fatal(err)
	}

	img, err := d.End()
	if err != nil {
		t.Fatalf("End: %v", err)
	}
	if got := pixelAt(img, 0, 0); got != (Color{}) {
		t.Fatalf("background should stay transparent, got %+v", got)
	}
	if got := pixelAt(img, 1, 1); got != (Color{R: 255, A: 255}) {
		t.Fatalf("red pixel: got %+v", got)
	}
	// 透明索引不覆盖透明底图。
	if got := pixelAt(img, 3, 1); got != (Color{}) {
		t.Fatalf("transparent index overwrote backdrop: %+v", got)
	}
	if got := pixelAt(img, 3, 2); got != (Color{G: 255, A: 255}) {
		t.Fatalf("green pixel: got %+v", got)
	}
}

// 游程可跨片：按单字节分片，使 (count,index) 对被切断。
func TestRunAcrossFragments(t *testing.T) {
	d := NewDecoder()
	rle := rleRow([2]byte{4, 5})
	def := encodeObject(4, 1, rle)
	for _, f := range splitFragments(3, 9, def, 1) {
		mustAdd(t, d, f)
	}
	p := NewPalette(2)
	p.Entries[5] = Color{B: 10, A: 255}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}
	if err := d.SetDisplayList(&DisplayList{
		Width: 4, Height: 1,
		Objects: []DisplayObject{{ObjectID: 3, ObjectVersion: 9, PaletteVersion: 2}},
	}); err != nil {
		t.Fatal(err)
	}
	img, err := d.End()
	if err != nil {
		t.Fatalf("End: %v", err)
	}
	for x := 0; x < 4; x++ {
		if got := pixelAt(img, x, 0); got != (Color{B: 10, A: 255}) {
			t.Fatalf("x=%d got %+v", x, got)
		}
	}
}

// 新旧版本交错到达：同 ID 两版本互不污染，显示列表固定引用各自版本。
func TestInterleavedVersions(t *testing.T) {
	d := NewDecoder()
	oldDef := encodeObject(1, 1, rleRow([2]byte{1, 1}))
	newDef := encodeObject(1, 1, rleRow([2]byte{1, 2}))

	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(oldDef)), Offset: 0, Data: oldDef[:2]})
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 2, TotalLength: uint32(len(newDef)), Offset: 0, Data: newDef[:2]})
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(oldDef)), Offset: 2, Data: oldDef[2:]})
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 2, TotalLength: uint32(len(newDef)), Offset: 2, Data: newDef[2:]})

	p := NewPalette(1)
	p.Entries[1] = Color{R: 1, A: 255}
	p.Entries[2] = Color{G: 1, A: 255}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}

	if err := d.SetDisplayList(&DisplayList{
		Width: 1, Height: 1,
		Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	img, err := d.End()
	if err != nil {
		t.Fatalf("End: %v", err)
	}
	if got := pixelAt(img, 0, 0); got != (Color{R: 1, A: 255}) {
		t.Fatalf("expected old version red, got %+v", got)
	}

	if err := d.SetDisplayList(&DisplayList{
		Width: 1, Height: 1,
		Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 2, PaletteVersion: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	img, err = d.End()
	if err != nil {
		t.Fatalf("End v2: %v", err)
	}
	if got := pixelAt(img, 0, 0); got != (Color{G: 1, A: 255}) {
		t.Fatalf("expected new version green, got %+v", got)
	}
}

// 重叠分片必须一致，不一致即拒绝；一致的重叠允许重组成功。
func TestOverlappingFragments(t *testing.T) {
	d := NewDecoder()
	def := encodeObject(2, 1, rleRow([2]byte{2, 7}))

	// 一致的重叠区间 [0,3)。
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Offset: 0, Data: def[:4]})
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Offset: 3, Data: def[3:]})

	bad := append([]byte(nil), def[:3]...)
	bad[1] ^= 0xff
	err := d.AddObject(ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Offset: 0, Data: bad})
	if !errors.Is(err, ErrInconsistentFragment) {
		t.Fatalf("expected ErrInconsistentFragment, got %v", err)
	}

	err = d.AddObject(ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Offset: uint32(len(def)), Data: []byte{1}})
	if !errors.Is(err, ErrInvalidFragment) {
		t.Fatalf("expected ErrInvalidFragment, got %v", err)
	}

	p := NewPalette(1)
	p.Entries[7] = Color{A: 255}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}
	if err := d.SetDisplayList(&DisplayList{
		Width: 2, Height: 1,
		Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.End(); err != nil {
		t.Fatalf("consistent overlap should compose: %v", err)
	}
}

// 行宽不足、超长、缺行、多行都必须拒绝。
func TestRowWidthViolations(t *testing.T) {
	p := NewPalette(1)
	p.Entries[1] = Color{A: 255}

	cases := map[string]struct {
		width, height int
		rle           []byte
	}{
		"short":       {3, 1, rleRow([2]byte{2, 1})},
		"long":        {3, 1, rleRow([2]byte{4, 1})},
		"missing row": {1, 2, rleRow([2]byte{1, 1})},
		"extra row":   {1, 1, append(rleRow([2]byte{1, 1}), rleRow([2]byte{1, 1})...)},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			d := NewDecoder()
			def := encodeObject(tc.width, tc.height, tc.rle)
			mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Data: def})
			if err := d.AddPalette(p); err != nil {
				t.Fatal(err)
			}
			if err := d.SetDisplayList(&DisplayList{
				Width: tc.width, Height: tc.height,
				Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1}},
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := d.End(); !errors.Is(err, ErrInvalidObject) {
				t.Fatalf("expected ErrInvalidObject, got %v", err)
			}
		})
	}
}

// 坐标越界整次拒绝；失败后列表保留，修正坐标即可成功合成。
func TestOutOfBoundsRejectsWholeComposition(t *testing.T) {
	d := NewDecoder()
	def := encodeObject(1, 1, rleRow([2]byte{1, 1}))
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Data: def})
	p := NewPalette(1)
	p.Entries[1] = Color{R: 255, A: 255}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}

	badPositions := []struct{ x, y int }{{-1, 0}, {0, -1}, {2, 0}, {0, 2}}
	for _, pos := range badPositions {
		if err := d.SetDisplayList(&DisplayList{
			Width: 2, Height: 2,
			Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1, X: pos.x, Y: pos.y}},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := d.End(); !errors.Is(err, ErrOutOfBounds) {
			t.Fatalf("pos (%d,%d): expected ErrOutOfBounds, got %v", pos.x, pos.y, err)
		}
	}

	if err := d.SetDisplayList(&DisplayList{
		Width: 2, Height: 2,
		Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1, X: 1, Y: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	img, err := d.End()
	if err != nil {
		t.Fatalf("retry End: %v", err)
	}
	if got := pixelAt(img, 1, 1); got != (Color{R: 255, A: 255}) {
		t.Fatalf("got %+v", got)
	}
}

// 未齐备前不合成：分片有缺口、缺调色板、无显示列表都返回 ErrNotReady。
func TestNotReadyGating(t *testing.T) {
	d := NewDecoder()
	def := encodeObject(1, 1, rleRow([2]byte{1, 1}))

	// 无显示列表。
	if _, err := d.End(); !errors.Is(err, ErrNotReady) {
		t.Fatalf("no list: expected ErrNotReady, got %v", err)
	}

	// 只发前半，制造空洞。
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Offset: 0, Data: def[:2]})
	p := NewPalette(1)
	p.Entries[1] = Color{A: 255}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}
	if err := d.SetDisplayList(&DisplayList{
		Width: 1, Height: 1,
		Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.End(); !errors.Is(err, ErrNotReady) {
		t.Fatalf("gap: expected ErrNotReady, got %v", err)
	}

	// 补齐后成功。
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Offset: 2, Data: def[2:]})
	if _, err := d.End(); err != nil {
		t.Fatalf("complete: %v", err)
	}

	// 成功后待显示列表已清除。
	if _, err := d.End(); !errors.Is(err, ErrNotReady) {
		t.Fatalf("post-success: expected ErrNotReady, got %v", err)
	}
}

// 缺失调色板版本同样阻塞合成。
func TestMissingPaletteGating(t *testing.T) {
	d := NewDecoder()
	def := encodeObject(1, 1, rleRow([2]byte{1, 1}))
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Data: def})
	if err := d.SetDisplayList(&DisplayList{
		Width: 1, Height: 1,
		Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 7}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.End(); !errors.Is(err, ErrNotReady) {
		t.Fatalf("expected ErrNotReady, got %v", err)
	}
}

// 预乘 RGBA：半透明颜色按 source-over 与底图混合，结果为预乘值。
func TestPremultipliedBlend(t *testing.T) {
	d := NewDecoder()
	// 底图层：不透明红；上层：50% 绿，放在同一像素。
	redDef := encodeObject(1, 1, rleRow([2]byte{1, 1}))
	greenDef := encodeObject(1, 1, rleRow([2]byte{1, 2}))
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(redDef)), Data: redDef})
	mustAdd(t, d, ObjectFragment{ID: 2, Version: 1, TotalLength: uint32(len(greenDef)), Data: greenDef})

	p := NewPalette(1)
	p.Entries[1] = Color{R: 255, G: 0, B: 0, A: 255}
	p.Entries[2] = Color{R: 0, G: 255, B: 0, A: 128}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}
	if err := d.SetDisplayList(&DisplayList{
		Width: 1, Height: 1,
		Objects: []DisplayObject{
			{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1},
			{ObjectID: 2, ObjectVersion: 1, PaletteVersion: 1},
		},
	}); err != nil {
		t.Fatal(err)
	}
	img, err := d.End()
	if err != nil {
		t.Fatalf("End: %v", err)
	}

	// sa=128, inv=127；sr=0, sg=128, sb=0；底图红 (255,0,0,255)。
	want := Color{
		R: uint8(255 * 127 / 255),
		G: 128,
		A: uint8(128 + 255*127/255),
	}
	if got := pixelAt(img, 0, 0); got != want {
		t.Fatalf("premultiplied blend: got %+v want %+v", got, want)
	}
	// image.RGBA 契约：像素必须是预乘值，R/G/B 不超过 A。
	c := pixelAt(img, 0, 0)
	if c.R > c.A || c.G > c.A || c.B > c.A {
		t.Fatalf("result not premultiplied: %+v", c)
	}
}

// 手动回收：未被引用的对象/调色板可回收，被待显示列表钉住的拒绝。
func TestEvictionPinning(t *testing.T) {
	d := NewDecoder()
	def := encodeObject(1, 1, rleRow([2]byte{1, 1}))
	mustAdd(t, d, ObjectFragment{ID: 1, Version: 1, TotalLength: uint32(len(def)), Data: def})
	p := NewPalette(1)
	p.Entries[1] = Color{A: 255}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}
	if err := d.SetDisplayList(&DisplayList{
		Width: 1, Height: 1,
		Objects: []DisplayObject{{ObjectID: 1, ObjectVersion: 1, PaletteVersion: 1}},
	}); err != nil {
		t.Fatal(err)
	}

	if err := d.EvictObject(1, 1); !errors.Is(err, ErrPinned) {
		t.Fatalf("pinned object: expected ErrPinned, got %v", err)
	}
	if err := d.EvictPalette(1); !errors.Is(err, ErrPinned) {
		t.Fatalf("pinned palette: expected ErrPinned, got %v", err)
	}

	// 合成成功解除钉住后可回收。
	if _, err := d.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	if err := d.EvictObject(1, 1); err != nil {
		t.Fatalf("evict after compose: %v", err)
	}
	if err := d.EvictPalette(1); err != nil {
		t.Fatalf("evict palette: %v", err)
	}

	// 回收不存在的条目不是错误。
	if err := d.EvictObject(99, 99); err != nil {
		t.Fatalf("evict missing: %v", err)
	}
}

// LRU 回收不破坏待显示列表：被钉住的对象即使最旧也保留，合成仍成功。
func TestLRUKeepsPinnedDisplayList(t *testing.T) {
	d := NewDecoder()
	d.SetCacheLimit(2)
	p := NewPalette(1)
	p.Entries[1] = Color{R: 255, A: 255}
	if err := d.AddPalette(p); err != nil {
		t.Fatal(err)
	}

	// 对象 A 最先到达（LRU 最旧），并被显示列表引用。
	defA := encodeObject(1, 1, rleRow([2]byte{1, 1}))
	mustAdd(t, d, ObjectFragment{ID: 10, Version: 1, TotalLength: uint32(len(defA)), Data: defA})
	if err := d.SetDisplayList(&DisplayList{
		Width: 1, Height: 1,
		Objects: []DisplayObject{{ObjectID: 10, ObjectVersion: 1, PaletteVersion: 1}},
	}); err != nil {
		t.Fatal(err)
	}

	// 再塞入两个无关对象触发 LRU 回收，A 因被钉住必须保留。
	for _, id := range []uint16{11, 12} {
		def := encodeObject(1, 1, rleRow([2]byte{1, 1}))
		mustAdd(t, d, ObjectFragment{ID: id, Version: 1, TotalLength: uint32(len(def)), Data: def})
	}

	img, err := d.End()
	if err != nil {
		t.Fatalf("pinned object must survive LRU: %v", err)
	}
	if got := pixelAt(img, 0, 0); got != (Color{R: 255, A: 255}) {
		t.Fatalf("got %+v", got)
	}

	// 未钉住的旧对象已被 LRU 回收。
	d.mu.Lock()
	_, keepB := d.objects[objectKey{11, 1}]
	_, keepC := d.objects[objectKey{12, 1}]
	d.mu.Unlock()
	if keepB || !keepC {
		t.Fatalf("LRU expectation wrong: obj11 kept=%v obj12 kept=%v", keepB, keepC)
	}
}

// 并发调用不应产生数据竞争或内部状态损坏。
func TestConcurrentAccess(t *testing.T) {
	d := NewDecoder()
	def := encodeObject(1, 1, rleRow([2]byte{1, 1}))

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := uint16(i%4 + 1)
			_ = d.AddObject(ObjectFragment{ID: id, Version: 1, TotalLength: uint32(len(def)), Data: def})
			_ = d.EvictObject(uint16(i%8+100), 1)
		}(i)
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p := NewPalette(1)
			p.Entries[1] = Color{A: 255}
			_ = d.AddPalette(p)
			_, _ = d.End()
		}()
	}
	wg.Wait()
}
