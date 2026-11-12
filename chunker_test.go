package dataeng

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"math/big"
	"math/rand"
	"testing"
)

// refHash 按规范从头重算 data 末尾至多 w 个字节的滚动摘要，
// 不做任何增量复用，作为流式实现的独立参考。
func refHash(data []byte, w int, mod uint64) uint64 {
	start := 0
	if len(data) > w {
		start = len(data) - w
	}
	m := new(big.Int).SetUint64(mod)
	h := new(big.Int)
	base := big.NewInt(257)
	for _, b := range data[start:] {
		h.Mul(h, base)
		h.Add(h, big.NewInt(int64(b)))
		h.Mod(h, m)
	}
	return h.Uint64()
}

type refChunk struct {
	start int64
	data  []byte
	sum   [sha256.Size]byte
}

// referenceChunker 逐字节重算窗口哈希，完整复刻切块判定，
// 包括跨块边界不清空窗口、min 限制和 max 强制边界。
func referenceChunker(data []byte, opts Options) []refChunk {
	var chunks []refChunk
	seen := make([]byte, 0, len(data))
	blockStart := 0
	for i, b := range data {
		seen = append(seen, b)
		length := i - blockStart + 1
		h := refHash(seen, opts.Window, opts.Mod)
		if length >= opts.Max || (length >= opts.Min && h == opts.Rem) {
			payload := data[blockStart : i+1]
			chunks = append(chunks, refChunk{
				start: int64(blockStart),
				data:  append([]byte(nil), payload...),
				sum:   sha256.Sum256(payload),
			})
			blockStart = i + 1
		}
	}
	if blockStart < len(data) {
		payload := data[blockStart:]
		chunks = append(chunks, refChunk{
			start: int64(blockStart),
			data:  append([]byte(nil), payload...),
			sum:   sha256.Sum256(payload),
		})
	}
	return chunks
}

// feedMode 控制一次 Write 送入多少字节。
type feedMode int

const (
	feedWhole feedMode = iota
	feedByte
	feedRandom
)

// runChunker 按给定输入切分方式和暂停策略驱动 Chunker，
// 暂停后按返回的消费位置保存剩余输入，Resume 后继续送入且不重发。
func runChunker(t *testing.T, data []byte, opts Options, mode feedMode, pauseEvery int) []Chunk {
	t.Helper()
	var got []Chunk
	emits := 0
	chunker, err := NewChunker(opts, func(ch Chunk) bool {
		got = append(got, ch)
		emits++
		return pauseEvery > 0 && emits%pauseEvery == 0
	})
	if err != nil {
		t.Fatalf("NewChunker: %v", err)
	}

	rng := rand.New(rand.NewSource(int64(opts.Window)*7 + int64(opts.Max)*13 + int64(len(data))))
	remaining := data
	for len(remaining) > 0 {
		var n int
		switch mode {
		case feedWhole:
			n = len(remaining)
		case feedByte:
			n = 1
		default:
			n = 1 + rng.Intn(len(remaining))
		}

		consumed, writeErr := chunker.Write(remaining[:n])
		if writeErr != nil && !errors.Is(writeErr, ErrPaused) {
			t.Fatalf("Write: %v", writeErr)
		}
		if consumed > n {
			t.Fatalf("consumed %d > offered %d", consumed, n)
		}
		if writeErr == ErrPaused {
			if _, err := chunker.Write(nil); !errors.Is(err, ErrPaused) {
				t.Fatalf("Write while paused should return ErrPaused, got %v", err)
			}
			if err := chunker.Finish(); !errors.Is(err, ErrPaused) {
				t.Fatalf("Finish while paused should return ErrPaused, got %v", err)
			}
			chunker.Resume()
		}
		// 仅推进已消费部分，保证暂停后剩余输入不丢也不重发。
		remaining = remaining[consumed:]
	}
	// 残块交付本身也可能触发暂停，恢复后重试 Finish。
	for {
		err := chunker.Finish()
		if err == nil {
			break
		}
		if !errors.Is(err, ErrPaused) {
			t.Fatalf("Finish: %v", err)
		}
		chunker.Resume()
	}
	return got
}

func assertChunks(t *testing.T, data []byte, opts Options, got []Chunk) {
	t.Helper()
	want := referenceChunker(data, opts)
	if len(got) != len(want) {
		t.Fatalf("opts=%+v len(data)=%d: got %d chunks, want %d", opts, len(data), len(got), len(want))
	}
	cursor := int64(0)
	for i, w := range want {
		g := got[i]
		if g.Start != w.start {
			t.Fatalf("chunk %d start: got %d want %d (opts=%+v)", i, g.Start, w.start, opts)
		}
		if g.Start != cursor {
			t.Fatalf("chunk %d start %d leaves a gap, expected %d", i, g.Start, cursor)
		}
		if !bytes.Equal(g.Data, w.data) {
			t.Fatalf("chunk %d data mismatch (opts=%+v)", i, opts)
		}
		if g.Sum != w.sum {
			t.Fatalf("chunk %d sha256 mismatch (opts=%+v)", i, opts)
		}
		if sha256.Sum256(g.Data) != g.Sum {
			t.Fatalf("chunk %d sum does not hash its data", i)
		}
		cursor += int64(len(g.Data))
		if i < len(want)-1 && len(g.Data) < opts.Min {
			t.Fatalf("non-final chunk %d shorter than Min", i)
		}
		if len(g.Data) > opts.Max {
			t.Fatalf("chunk %d longer than Max", i)
		}
	}
	if cursor != int64(len(data)) {
		t.Fatalf("chunks cover %d bytes, data has %d", cursor, len(data))
	}
}

func TestChunkerMatchesReference(t *testing.T) {
	mods := []uint64{2, 3, 7, 257, 65537, 1 << 32, 1<<63 - 1, ^uint64(0)}
	windows := []int{1, 3, 16, 64}
	sizes := [][2]int{{1, 1}, {1, 4}, {3, 10}, {8, 32}}
	lengths := []int{0, 1, 7, 50, 200}

	seed := int64(1)
	for _, mod := range mods {
		for _, window := range windows {
			for _, size := range sizes {
				for _, length := range lengths {
					rng := rand.New(rand.NewSource(seed))
					seed++
					data := make([]byte, length)
					rng.Read(data)

					rem := rng.Uint64() % mod
					opts := Options{
						Min:    size[0],
						Max:    size[1],
						Window: window,
						Mod:    mod,
						Rem:    rem,
					}
					for _, mode := range []feedMode{feedWhole, feedByte, feedRandom} {
						got := runChunker(t, data, opts, mode, 0)
						assertChunks(t, data, opts, got)
					}
				}
			}
		}
	}
}

func TestChunkerStructuredDataAndPauses(t *testing.T) {
	mods := []uint64{5, 257, 1 << 32, ^uint64(0)}
	for _, mod := range mods {
		for _, rem := range []uint64{0, 1, mod - 1} {
			data := make([]byte, 180)
			for i := range data {
				data[i] = byte((i*31 + 7) % 256)
			}
			opts := Options{Min: 4, Max: 17, Window: 9, Mod: mod, Rem: rem}
			for _, pauseEvery := range []int{1, 2, 3} {
				got := runChunker(t, data, opts, feedRandom, pauseEvery)
				assertChunks(t, data, opts, got)
			}
		}
	}
}

func TestEmptyFileProducesZeroChunks(t *testing.T) {
	opts := Options{Min: 2, Max: 8, Window: 4, Mod: 257, Rem: 0}
	got := runChunker(t, nil, opts, feedWhole, 0)
	if len(got) != 0 {
		t.Fatalf("empty input produced %d chunks", len(got))
	}

	chunker, err := NewChunker(opts, func(Chunk) bool { return false })
	if err != nil {
		t.Fatal(err)
	}
	if err := chunker.Finish(); err != nil {
		t.Fatalf("Finish on empty stream: %v", err)
	}
}

func TestForcedMaxBoundary(t *testing.T) {
	// 常量字节配合无法命中的余数，保证每个块只能由 Max 强制切出。
	opts := Options{Min: 2, Max: 8, Window: 3, Mod: 257, Rem: 200}
	data := bytes.Repeat([]byte{1}, 25)
	got := runChunker(t, data, opts, feedByte, 0)

	if len(got) != 4 {
		t.Fatalf("got %d chunks, want 4 (three full Max chunks plus residual)", len(got))
	}
	for i := 0; i < 3; i++ {
		if len(got[i].Data) != opts.Max {
			t.Fatalf("chunk %d length %d, want forced Max %d", i, len(got[i].Data), opts.Max)
		}
		if got[i].Start != int64(i*opts.Max) {
			t.Fatalf("chunk %d start %d", i, got[i].Start)
		}
	}
	assertChunks(t, data, opts, got)
}

func TestPauseResumeDoesNotResend(t *testing.T) {
	opts := Options{Min: 1, Max: 5, Window: 4, Mod: 251, Rem: 3}
	data := []byte("content-defined-chunking-stream-0123456789")

	var got []Chunk
	chunker, err := NewChunker(opts, func(ch Chunk) bool {
		got = append(got, ch)
		return true // 每个块都暂停
	})
	if err != nil {
		t.Fatal(err)
	}

	remaining := data
	pauses := 0
	guards := 0
	for len(remaining) > 0 {
		guards++
		if guards > 2*len(data)+5 {
			t.Fatal("pause/resume loop did not make progress")
		}
		n := 1 + len(remaining)/2
		consumed, writeErr := chunker.Write(remaining[:n])
		if writeErr != nil && !errors.Is(writeErr, ErrPaused) {
			t.Fatalf("unexpected Write error: %v", writeErr)
		}
		if writeErr == ErrPaused {
			pauses++
			chunker.Resume()
		}
		remaining = remaining[consumed:]
	}
	for {
		err := chunker.Finish()
		if err == nil {
			break
		}
		if !errors.Is(err, ErrPaused) {
			t.Fatalf("Finish: %v", err)
		}
		pauses++
		chunker.Resume()
	}
	if pauses != len(got) {
		t.Fatalf("pauses=%d chunks=%d, expected equal", pauses, len(got))
	}
	// 与每字节重算的参考实现逐块比对，确认没有重发或丢失。
	assertChunks(t, data, opts, got)

	chunker.Resume() // 恢复后再次 Resume 是无害空操作
}

func TestWindowSurvivesChunkBoundaries(t *testing.T) {
	// 窗口宽度大于块长，若边界处错误清空窗口，参考实现会与流式实现分叉。
	opts := Options{Min: 1, Max: 3, Window: 12, Mod: 997, Rem: 11}
	rng := rand.New(rand.NewSource(42))
	data := make([]byte, 140)
	rng.Read(data)
	assertChunks(t, data, opts, runChunker(t, data, opts, feedByte, 0))
}

func powRef(base uint64, exp int, mod uint64) uint64 {
	result := big.NewInt(1)
	b := new(big.Int).SetUint64(base)
	m := new(big.Int).SetUint64(mod)
	for i := 0; i < exp; i++ {
		product := new(big.Int).Mul(result, b)
		result = product.Mod(product, m)
	}
	return result.Uint64()
}

func TestModularArithmeticNoOverflowReliance(t *testing.T) {
	for _, m := range []uint64{1<<63 - 1, ^uint64(0), ^uint64(0) - 1, 1 << 32} {
		// 覆盖小值、边界值和 128 位乘法的极端高位输入，全部严格小于 m。
		operands := []uint64{0, 1, 2, 256, 257, m - 1, m - 2, m / 257, m % 257}
		// addMod 的第二参数实际来自字节，单独覆盖可能大于小模数的字节值。
		byteLike := []uint64{0, 1, 2, 255, 256}
		for _, a := range operands {
			// 所有运算数严格小于 m，避免测试字面量自身发生 uint64 回绕。
			for _, b := range operands {
				wantMul := new(big.Int).Mul(new(big.Int).SetUint64(a), new(big.Int).SetUint64(b))
				wantMul.Mod(wantMul, new(big.Int).SetUint64(m))
				if got := mulMod(a, b, m); got != wantMul.Uint64() {
					t.Fatalf("mulMod(%d,%d,%d)=%d want %d", a, b, m, got, wantMul)
				}
			}
			for _, b := range byteLike {
				wantAdd := new(big.Int).Add(new(big.Int).SetUint64(a), new(big.Int).SetUint64(b))
				wantAdd.Mod(wantAdd, new(big.Int).SetUint64(m))
				if got := addMod(a, b, m); got != wantAdd.Uint64() {
					t.Fatalf("addMod(%d,%d,%d)=%d want %d", a, b, m, got, wantAdd)
				}
				wantSub := new(big.Int).Sub(new(big.Int).SetUint64(a), new(big.Int).SetUint64(b))
				wantSub.Mod(wantSub, new(big.Int).SetUint64(m))
				if got := subMod(a, b, m); got != wantSub.Uint64() {
					t.Fatalf("subMod(%d,%d,%d)=%d want %d", a, b, m, got, wantSub)
				}
			}
		}
	}

	for _, exp := range []int{1, 2, 5, 20, 64} {
		want := powRef(257, exp, ^uint64(0))
		if got := powMod(257, exp, ^uint64(0)); got != want {
			t.Fatalf("powMod exp=%d: got %d want %d", exp, got, want)
		}
	}
}

func TestInvalidOptions(t *testing.T) {
	ok := Options{Min: 1, Max: 2, Window: 3, Mod: 5, Rem: 0}
	cases := map[string]Options{
		"min zero":       {Min: 0, Max: 2, Window: 3, Mod: 5, Rem: 0},
		"min above max":  {Min: 3, Max: 2, Window: 3, Mod: 5, Rem: 0},
		"zero window":    {Min: 1, Max: 2, Window: 0, Mod: 5, Rem: 0},
		"mod one":        {Min: 1, Max: 2, Window: 3, Mod: 1, Rem: 0},
		"rem equals mod": {Min: 1, Max: 2, Window: 3, Mod: 5, Rem: 5},
	}
	for name, opts := range cases {
		if _, err := NewChunker(opts, func(Chunk) bool { return false }); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}
	if _, err := NewChunker(ok, nil); err == nil {
		t.Fatal("nil emit callback should be rejected")
	}
	if _, err := NewChunker(ok, func(Chunk) bool { return false }); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
}

func TestSingleByteChunks(t *testing.T) {
	opts := Options{Min: 1, Max: 1, Window: 5, Mod: 257, Rem: 0}
	rng := rand.New(rand.NewSource(7))
	data := make([]byte, 60)
	rng.Read(data)
	got := runChunker(t, data, opts, feedRandom, 2)
	assertChunks(t, data, opts, got)
	if len(got) != len(data) {
		t.Fatalf("Min=Max=1 should yield one chunk per byte, got %d", len(got))
	}
	for i, ch := range got {
		if ch.Start != int64(i) || len(ch.Data) != 1 || ch.Data[0] != data[i] {
			t.Fatalf("chunk %d does not match byte %d", i, i)
		}
	}
}

func TestRandomizedStressAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for iter := 0; iter < 120; iter++ {
		mod := rng.Uint64()
		if mod <= 1 {
			mod += 2
		}
		min := 1 + rng.Intn(12)
		max := min + rng.Intn(40)
		opts := Options{
			Min:    min,
			Max:    max,
			Window: 1 + rng.Intn(33),
			Mod:    mod,
			Rem:    rng.Uint64() % mod,
		}
		data := make([]byte, rng.Intn(400))
		rng.Read(data)

		mode := []feedMode{feedWhole, feedByte, feedRandom}[rng.Intn(3)]
		pauseEvery := []int{0, 1, 2, 5}[rng.Intn(4)]
		got := runChunker(t, data, opts, mode, pauseEvery)
		assertChunks(t, data, opts, got)
	}
}

func TestChunkDataIsIndependentCopy(t *testing.T) {
	opts := Options{Min: 1, Max: 2, Window: 2, Mod: 257, Rem: 200}
	data := []byte{9, 8, 7, 6}
	var delivered [][]byte
	var snapshot [][]byte
	chunker, err := NewChunker(opts, func(ch Chunk) bool {
		delivered = append(delivered, ch.Data)
		snapshot = append(snapshot, append([]byte(nil), ch.Data...))
		return false
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := chunker.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := chunker.Finish(); err != nil {
		t.Fatal(err)
	}

	// 交付后篡改输入，确认已交付的块字节不受影响（Data 是独立副本）。
	for i := range data {
		data[i] = 0
	}
	for i, d := range delivered {
		if !bytes.Equal(d, snapshot[i]) {
			t.Fatalf("chunk %d aliases caller buffer: got %v want %v", i, d, snapshot[i])
		}
	}
	chunker.Resume()
}
