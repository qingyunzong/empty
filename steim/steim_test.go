package steim_test

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"

	"example.org/dataeng/q0295/steim"
)

// This test suite contains a fully independent bit-level reference
// decoder written in a different style than the package under test
// (explicit per-bit shifts and subtraction-based sign extension). The
// package output is cross-checked against it field by field.

type refDiff struct {
	value                int32
	frame, word, ordinal int
}

type refSample struct {
	value             int32
	frame, word, diff int
}

// refSign sign-extends by subtracting 2^width, deliberately unlike the
// mask-OR implementation in the package.
func refSign(raw uint32, width int) int32 {
	if width == 32 {
		return int32(raw)
	}
	if raw&(uint32(1)<<uint(width-1)) != 0 {
		return int32(int64(raw) - (int64(1) << uint(width)))
	}
	return int32(raw)
}

func refDecode(enc, n int, body []byte) ([]refSample, error) {
	if len(body) == 0 || len(body)%64 != 0 {
		return nil, errors.New("ref: bad body length")
	}
	frameCount := len(body) / 64
	stream := make([]refDiff, 0, n)

	for frame := 0; frame < frameCount; frame++ {
		words := make([]uint32, 16)
		for k := range words {
			words[k] = binary.BigEndian.Uint32(body[frame*64+4*k:])
		}
		controlWord := words[0]
		for j := 0; j < 16; j++ {
			code := int((controlWord >> uint(30-2*j)) & 0b11)
			if j == 0 && code != 0 {
				return nil, errors.New("ref: control word's own code must be 0")
			}
			if code == 0 {
				continue
			}
			if frame == 0 && (j == 1 || j == 2) {
				return nil, errors.New("ref: frame 0 integration slots need code 0")
			}

			var widths []int
			top, container := 0, 32
			switch enc {
			case 1:
				switch code {
				case 1:
					widths = []int{8, 8, 8, 8}
				case 2:
					widths = []int{16, 16}
				case 3:
					widths = []int{32}
				default:
					return nil, errors.New("ref: illegal Steim-1 code")
				}
			case 2:
				top = int(words[j] >> 30)
				switch code {
				case 1:
					widths = []int{8, 8, 8, 8}
				case 2:
					if top == 0 {
						return nil, errors.New("ref: code 2 dnib 0 illegal")
					}
					container = 30
					switch top {
					case 1:
						widths = []int{30}
					case 2:
						widths = []int{15, 15}
					case 3:
						widths = []int{10, 10, 10}
					}
				case 3:
					container = 30
					switch top {
					case 0:
						widths = []int{6, 6, 6, 6, 6}
					case 1:
						widths = []int{5, 5, 5, 5, 5, 5}
					case 2:
						container = 28
						widths = []int{4, 4, 4, 4, 4, 4, 4}
					case 3:
						return nil, errors.New("ref: code 3 dnib 3 illegal")
					}
				default:
					return nil, errors.New("ref: illegal Steim-2 code")
				}
			}

			shift := container
			for ordinal, width := range widths {
				shift -= width
				var raw uint32
				if width == 32 {
					raw = words[j]
				} else {
					raw = (words[j] >> uint(shift)) & ((uint32(1) << uint(width)) - 1)
				}
				stream = append(stream, refDiff{
					value:   refSign(raw, width),
					frame:   frame,
					word:    j,
					ordinal: ordinal,
				})
			}
		}
	}

	if len(stream) < n {
		return nil, errors.New("ref: fewer than N differences")
	}

	x0 := int32(binary.BigEndian.Uint32(body[4:]))
	xn := int32(binary.BigEndian.Uint32(body[8:]))
	out := make([]refSample, 0, n)
	out = append(out, refSample{value: x0, frame: 0, word: 1, diff: -1})

	acc := uint32(x0)
	for s := 1; s < n; s++ {
		acc += uint32(stream[s].value)
		out = append(out, refSample{
			value: int32(acc),
			frame: stream[s].frame,
			word:  stream[s].word,
			diff:  stream[s].ordinal,
		})
	}
	if out[n-1].value != xn {
		return nil, errors.New("ref: final sample differs from Xn")
	}
	return out, nil
}

// ---- Record builders (independent of package code) ----

type wordSpec struct {
	frame, index, code, dnib int
	widths                   []int
	vals                     []int64
}

func minNeg(width int) int64 { return -int64(1) << uint(width-1) }
func maxPos(width int) int64 { return int64(1)<<uint(width-1) - 1 }

// packWord lays fields out from the high bit of the low container
// bits. top (the dnib) occupies bits 31..30 when container < 32.
func packWord(widths []int, vals []int64, top uint32, container int) uint32 {
	if len(widths) != len(vals) {
		panic("builder: widths/vals mismatch")
	}
	var packed uint32
	pos := container
	for i, width := range widths {
		pos -= width
		mask := int64(1)<<uint(width) - 1
		field := uint32(vals[i] & mask)
		if width == 32 {
			packed = field
			continue
		}
		packed |= field << uint(pos)
	}
	if container == 32 {
		return packed
	}
	return top<<30 | packed
}

func makeFrame(controls [16]int, data [16]uint32) [16]uint32 {
	var controlWord uint32
	for j, code := range controls {
		controlWord |= uint32(code) << uint(30-2*j)
	}
	data[0] = controlWord
	return data
}

func buildRecord(x0, xn uint32, frames ...[16]uint32) []byte {
	body := make([]byte, 64*len(frames))
	for fi, fr := range frames {
		if fi == 0 {
			fr[1] = x0
			fr[2] = xn
		}
		for wi, word := range fr {
			binary.BigEndian.PutUint32(body[fi*64+4*wi:], word)
		}
	}
	return body
}

func accumulate(x0 int32, deltas ...int64) uint32 {
	acc := uint32(x0)
	for _, delta := range deltas {
		acc += uint32(int32(delta))
	}
	return acc
}

// buildFromSpecs turns word specs into a record body. The first field
// of the first spec is the bridge d0 and never enters the integration
// path that determines Xn.
func buildFromSpecs(enc int, x0 int32, specs []wordSpec) ([]byte, int) {
	lastFrame := 0
	for _, spec := range specs {
		if spec.frame > lastFrame {
			lastFrame = spec.frame
		}
	}
	data := make([][16]uint32, lastFrame+1)
	controls := make([][16]int, lastFrame+1)

	n := 0
	integrated := make([]int64, 0)
	for si, spec := range specs {
		container, top := 32, uint32(0)
		if enc == 2 && (spec.code == 2 || spec.code == 3) {
			top = uint32(spec.dnib)
			if spec.code == 3 && spec.dnib == 2 {
				container = 28
			} else {
				container = 30
			}
		}
		data[spec.frame][spec.index] = packWord(spec.widths, spec.vals, top, container)
		controls[spec.frame][spec.index] = spec.code
		n += len(spec.vals)
		for vi, v := range spec.vals {
			if si != 0 || vi != 0 {
				integrated = append(integrated, v)
			}
		}
	}

	frames := make([][16]uint32, lastFrame+1)
	for f := range frames {
		frames[f] = makeFrame(controls[f], data[f])
	}
	xn := accumulate(x0, integrated...)
	return buildRecord(uint32(x0), xn, frames...), n
}

// ---- Pipeline helpers ----

func deliver(t *testing.T, enc, n int, body []byte, maxN, chunk int) []steim.Sample {
	t.Helper()
	dec, err := steim.NewDecoder(enc, n, len(body), maxN)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	if chunk <= 0 {
		if err := dec.Push(body); err != nil {
			t.Fatalf("Push whole: %v", err)
		}
	} else {
		for off := 0; off < len(body); {
			end := off + chunk
			if end > len(body) {
				end = len(body)
			}
			if err := dec.Push(body[off:end]); err != nil {
				t.Fatalf("Push [%d:%d]: %v", off, end, err)
			}
			off = end
		}
	}
	samples, err := dec.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return samples
}

func deliverChunks(t *testing.T, enc, n int, body []byte, sizes []int) []steim.Sample {
	t.Helper()
	dec, err := steim.NewDecoder(enc, n, len(body), math.MaxInt32)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	off := 0
	for _, size := range sizes {
		if size == 0 {
			if err := dec.Push(nil); err != nil {
				t.Fatalf("Push empty: %v", err)
			}
			continue
		}
		end := off + size
		if end > len(body) {
			end = len(body)
		}
		if err := dec.Push(body[off:end]); err != nil {
			t.Fatalf("Push [%d:%d]: %v", off, end, err)
		}
		off = end
	}
	samples, err := dec.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return samples
}

func assertRef(t *testing.T, enc, n int, body []byte, got []steim.Sample) {
	t.Helper()
	want, err := refDecode(enc, n, body)
	if err != nil {
		t.Fatalf("reference decoder: %v", err)
	}
	if len(got) != n || len(want) != n {
		t.Fatalf("sample count: got %d want %d", len(got), n)
	}
	for i := range got {
		if got[i].Value != want[i].value ||
			got[i].Frame != want[i].frame ||
			got[i].Word != want[i].word ||
			got[i].Diff != want[i].diff {
			t.Fatalf("sample %d mismatch: got %+v want %+v", i, got[i], want[i])
		}
	}
}

func assertValues(t *testing.T, got []steim.Sample, x0 int32, deltas []int64) {
	t.Helper()
	if got[0].Value != x0 || got[0].Frame != 0 || got[0].Word != 1 || got[0].Diff != -1 {
		t.Fatalf("X0 provenance wrong: %+v", got[0])
	}
	acc := uint32(x0)
	for i, delta := range deltas {
		acc += uint32(int32(delta))
		if got[i+1].Value != int32(acc) {
			t.Fatalf("sample %d: got %d want %d", i+1, got[i+1].Value, int32(acc))
		}
	}
}

// ---- Tests ----

func TestLegalGroupWidths(t *testing.T) {
	cases := []struct {
		name   string
		enc    int
		specs  []wordSpec
		deltas []int64
	}{
		{
			name:  "steim1-4x8",
			enc:   1,
			specs: []wordSpec{{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{minNeg(8), maxPos(8), minNeg(8), maxPos(8)}}},
			// d0 is skipped; integrated values include a minimum negative.
			deltas: []int64{maxPos(8), minNeg(8), maxPos(8)},
		},
		{
			name:   "steim1-2x16",
			enc:    1,
			specs:  []wordSpec{{0, 3, 2, 0, []int{16, 16}, []int64{maxPos(16), minNeg(16)}}},
			deltas: []int64{minNeg(16)},
		},
		{
			name: "steim1-1x32",
			enc:  1,
			specs: []wordSpec{
				{0, 3, 3, 0, []int{32}, []int64{12345}},
				{0, 4, 3, 0, []int{32}, []int64{minNeg(32)}},
			},
			deltas: []int64{minNeg(32)},
		},
		{
			name:   "steim2-4x8",
			enc:    2,
			specs:  []wordSpec{{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{minNeg(8), maxPos(8), minNeg(8), 1}}},
			deltas: []int64{maxPos(8), minNeg(8), 1},
		},
		{
			name:   "steim2-c2-dnib1-1x30",
			enc:    2,
			specs:  []wordSpec{{0, 3, 2, 1, []int{30}, []int64{minNeg(30)}}},
			deltas: nil,
		},
		{
			name:   "steim2-c2-dnib2-2x15",
			enc:    2,
			specs:  []wordSpec{{0, 3, 2, 2, []int{15, 15}, []int64{minNeg(15), maxPos(15)}}},
			deltas: []int64{maxPos(15)},
		},
		{
			name:   "steim2-c2-dnib3-3x10",
			enc:    2,
			specs:  []wordSpec{{0, 3, 2, 3, []int{10, 10, 10}, []int64{minNeg(10), maxPos(10), 4}}},
			deltas: []int64{maxPos(10), 4},
		},
		{
			name:   "steim2-c3-dnib0-5x6",
			enc:    2,
			specs:  []wordSpec{{0, 3, 3, 0, []int{6, 6, 6, 6, 6}, []int64{minNeg(6), maxPos(6), -1, 2, 3}}},
			deltas: []int64{maxPos(6), -1, 2, 3},
		},
		{
			name:   "steim2-c3-dnib1-6x5",
			enc:    2,
			specs:  []wordSpec{{0, 3, 3, 1, []int{5, 5, 5, 5, 5, 5}, []int64{minNeg(5), maxPos(5), 0, 1, -2, 4}}},
			deltas: []int64{maxPos(5), 0, 1, -2, 4},
		},
		{
			name: "steim2-c3-dnib2-7x4-ignored-bits",
			enc:  2,
			// Bits 29 and 28 are the ignored pair for the 7x4 layout;
			// they are set to 1 and must not change any field.
			specs:  []wordSpec{{0, 3, 3, 2, []int{4, 4, 4, 4, 4, 4, 4}, []int64{minNeg(4), maxPos(4), 0, 1, -2, 3, -4}}},
			deltas: []int64{maxPos(4), 0, 1, -2, 3, -4},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const x0 int32 = 1000
			body, n := buildFromSpecs(tc.enc, x0, tc.specs)
			if tc.name == "steim2-c3-dnib2-7x4-ignored-bits" {
				// Set the ignored bit pair (bits 29..28) to 1; valid
				// decoding must leave every field unchanged.
				body[3*4+2] |= 0x0C
			}
			got := deliver(t, tc.enc, n, body, math.MaxInt32, 1)
			assertValues(t, got, x0, tc.deltas)
			assertRef(t, tc.enc, n, body, got)

			// Prove the ignored 7x4 pair really is ignored: the same
			// record with the pair left zero must decode identically.
			if tc.name == "steim2-c3-dnib2-7x4-ignored-bits" {
				plain, _ := buildFromSpecs(tc.enc, x0, tc.specs)
				got2 := deliver(t, tc.enc, n, plain, math.MaxInt32, 7)
				assertRef(t, tc.enc, n, plain, got2)
				for i := range got {
					if got[i] != got2[i] {
						t.Fatalf("ignored bit pair changed sample %d", i)
					}
				}
			}
		})
	}
}

func TestCrossFrameIntegration(t *testing.T) {
	// Frame 0 contributes d0 plus three integrated differences, and
	// frame 1 continues the sequence without any reset.
	specs := []wordSpec{
		{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{9, 10, -20, 30}},
		{1, 1, 1, 0, []int{8, 8, 8, 8}, []int64{-40, 50, 60, 70}},
		{1, 2, 2, 0, []int{16, 16}, []int64{80, 90}},
		{1, 3, 3, 0, []int{32}, []int64{100}},
	}
	const x0 int32 = 500
	body, n := buildFromSpecs(1, x0, specs) // 11 diffs => 11 samples
	if n != 11 || len(body) != 128 {
		t.Fatalf("unexpected n=%d len=%d", n, len(body))
	}

	deltas := []int64{10, -20, 30, -40, 50, 60, 70, 80, 90, 100}

	// Exhaustive chunk sizes: every fixed cut size 1..L plus the
	// whole-body push must produce identical output.
	for chunk := 1; chunk <= len(body); chunk++ {
		got := deliver(t, 1, n, body, math.MaxInt32, chunk)
		assertValues(t, got, x0, deltas)
		assertRef(t, 1, n, body, got)
	}
	got := deliver(t, 1, n, body, math.MaxInt32, 0)

	// Provenance must track frame/word boundaries; d0 never gets a
	// sample slot, so indices stay contiguous.
	wantLoc := []struct{ frame, word, diff int }{
		{0, 1, -1}, // X0
		{0, 3, 1}, {0, 3, 2}, {0, 3, 3},
		{1, 1, 0}, {1, 1, 1}, {1, 1, 2}, {1, 1, 3},
		{1, 2, 0}, {1, 2, 1},
		{1, 3, 0},
	}
	if len(got) != len(wantLoc) {
		t.Fatalf("sample count %d", len(got))
	}
	for i, loc := range wantLoc {
		if got[i].Frame != loc.frame || got[i].Word != loc.word || got[i].Diff != loc.diff {
			t.Fatalf("sample %d provenance got (f=%d w=%d d=%d) want %+v",
				i, got[i].Frame, got[i].Word, got[i].Diff, loc)
		}
	}

	// Irregular chunking with empty pushes interleaved.
	jagged := deliverChunks(t, 1, n, body, []int{1, 1, 0, 63, 7, 0, 56})
	assertValues(t, jagged, x0, deltas)
	assertRef(t, 1, n, body, jagged)
}

func TestInt32Wraparound(t *testing.T) {
	cases := []struct {
		name string
		enc  int
		spec []wordSpec
	}{
		{
			name: "steim1-32bit-overflow",
			enc:  1,
			spec: []wordSpec{
				{0, 3, 3, 0, []int{32}, []int64{1}}, // d0
				{0, 4, 3, 0, []int{32}, []int64{int64(math.MaxInt32)}},
				{0, 5, 3, 0, []int{32}, []int64{2}},
			},
		},
		{
			name: "steim1-32bit-underflow",
			enc:  1,
			spec: []wordSpec{
				{0, 3, 3, 0, []int{32}, []int64{1}}, // d0
				{0, 4, 3, 0, []int{32}, []int64{int64(math.MinInt32)}},
				{0, 5, 3, 0, []int{32}, []int64{-3}},
			},
		},
		{
			name: "steim2-30bit-overflow",
			enc:  2,
			spec: []wordSpec{
				{0, 3, 2, 1, []int{30}, []int64{1}}, // d0
				{0, 4, 2, 1, []int{30}, []int64{maxPos(30)}},
				{0, 5, 2, 1, []int{30}, []int64{maxPos(30)}},
			},
		},
	}
	const x0 int32 = math.MaxInt32 - 1
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, n := buildFromSpecs(tc.enc, x0, tc.spec)
			got := deliver(t, tc.enc, n, body, math.MaxInt32, 3)
			assertRef(t, tc.enc, n, body, got)

			acc := uint32(x0)
			acc += uint32(int32(tc.spec[1].vals[0]))
			if got[1].Value != int32(acc) || got[1].Value > 0 {
				t.Fatalf("expected wrap into negative values, got %d (acc=%d)",
					got[1].Value, int32(acc))
			}
			acc += uint32(int32(tc.spec[2].vals[0]))
			if got[2].Value != int32(acc) {
				t.Fatalf("second wrap mismatch: got %d want %d", got[2].Value, int32(acc))
			}
		})
	}
}

func TestWrongXnRejected(t *testing.T) {
	body, n := buildFromSpecs(1, 7, []wordSpec{
		{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}},
	})
	// Flip the Xn slot at frame 0 word 2.
	body[8] ^= 0xFF
	dec, err := steim.NewDecoder(1, n, len(body), math.MaxInt32)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Push(body); err != nil {
		t.Fatal(err)
	}
	if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
		t.Fatalf("want ErrCorrupt, got %v", err)
	}
	if _, err := dec.Finish(); !errors.Is(err, steim.ErrState) {
		t.Fatalf("failed decoder must stay failed, got %v", err)
	}
}

func TestNonZeroD0AcceptedButSkipped(t *testing.T) {
	// d0 = 4242 is a bridge value: required to exist, never integrated,
	// never indexed as a sample.
	specs := []wordSpec{
		{0, 3, 3, 0, []int{32}, []int64{4242}},
		{0, 4, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}},
	}
	const x0 int32 = 10
	body, n := buildFromSpecs(1, x0, specs) // 5 diffs, 5 samples
	got := deliver(t, 1, n, body, math.MaxInt32, 1)
	assertValues(t, got, x0, []int64{1, 2, 3, 4})
	assertRef(t, 1, n, body, got)
	if got[0].Frame != 0 || got[0].Word != 1 || got[0].Diff != -1 {
		t.Fatalf("X0 provenance wrong: %+v", got[0])
	}
}

func TestNEqualsOne(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		// One 4x8 word supplies d0 plus padding; Xn must equal X0.
		frame := makeFrame(
			[16]int{0, 0, 0, 1},
			[16]uint32{0, 77, 77, packWord([]int{8, 8, 8, 8}, []int64{5, 6, 7, 8}, 0, 32)},
		)
		body := buildRecord(77, 77, frame)
		got := deliver(t, 1, 1, body, math.MaxInt32, 1)
		if len(got) != 1 || got[0].Value != 77 {
			t.Fatalf("unexpected samples %+v", got)
		}
		if got[0].Frame != 0 || got[0].Word != 1 || got[0].Diff != -1 {
			t.Fatalf("X0 provenance wrong: %+v", got[0])
		}
		assertRef(t, 1, 1, body, got)
	})

	t.Run("missing-d0-rejected", func(t *testing.T) {
		// Only control-0 words exist, so there is no difference at all.
		body := buildRecord(77, 77, makeFrame([16]int{}, [16]uint32{}))
		dec, err := steim.NewDecoder(1, 1, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
			t.Fatalf("want ErrCorrupt for missing d0, got %v", err)
		}
	})

	t.Run("xn-must-equal-x0", func(t *testing.T) {
		frame := makeFrame(
			[16]int{0, 0, 0, 1},
			[16]uint32{0, 0, 0, packWord([]int{8, 8, 8, 8}, []int64{5, 6, 7, 8}, 0, 32)},
		)
		body := buildRecord(77, 78, frame)
		dec, err := steim.NewDecoder(1, 1, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
			t.Fatalf("want ErrCorrupt for X0 != Xn, got %v", err)
		}
	})
}

func TestBadControlAfterNRejected(t *testing.T) {
	// Frame 0 already holds enough diffs for all samples; illegal
	// padding in a later frame must still be detected after N is met.
	t.Run("steim2-code2-dnib0", func(t *testing.T) {
		specs := []wordSpec{
			{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}}, // N=4
			{1, 1, 2, 1, []int{30}, []int64{0}},
		}
		body, n := buildFromSpecs(2, 11, specs)
		// Force the illegal dnib 0 in frame 1 word 1.
		offset := 64 + 1*4
		body[offset] &^= 0xC0
		dec, err := steim.NewDecoder(2, n, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
			t.Fatalf("want ErrCorrupt, got %v", err)
		}
	})

	t.Run("steim2-code3-dnib3", func(t *testing.T) {
		specs := []wordSpec{
			{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}},
			{1, 1, 3, 3, []int{6, 6, 6, 6, 6}, []int64{0, 0, 0, 0, 0}},
		}
		body, n := buildFromSpecs(2, 11, specs)
		dec, err := steim.NewDecoder(2, n, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
			t.Fatalf("want ErrCorrupt, got %v", err)
		}
	})

	t.Run("frame0-integration-slot-code-nonzero", func(t *testing.T) {
		var controls [16]int
		controls[2] = 1 // word 2 must stay control 0 (Xn slot)
		var data [16]uint32
		data[3] = packWord([]int{8, 8, 8, 8}, []int64{1, 2, 3, 4}, 0, 32)
		body := buildRecord(0, 9, makeFrame(controls, data))
		dec, err := steim.NewDecoder(1, 4, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
			t.Fatalf("want ErrCorrupt, got %v", err)
		}
	})

	t.Run("control-word-own-code-nonzero", func(t *testing.T) {
		var controls [16]int
		controls[0] = 2 // j=0 must be 0
		data := [16]uint32{0, 5, 5}
		body := buildRecord(5, 5, makeFrame(controls, data))
		dec, err := steim.NewDecoder(1, 1, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
			t.Fatalf("want ErrCorrupt, got %v", err)
		}
	})
}

func TestTooLargeAndTruncated(t *testing.T) {
	body, n := buildFromSpecs(1, 3, []wordSpec{
		{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}},
	})

	t.Run("push-past-L-rejected", func(t *testing.T) {
		dec, err := steim.NewDecoder(1, n, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if err := dec.Push([]byte{0}); !errors.Is(err, steim.ErrTooLarge) {
			t.Fatalf("want ErrTooLarge, got %v", err)
		}
		// The failure is terminal.
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrState) {
			t.Fatalf("want ErrState after failure, got %v", err)
		}
	})

	t.Run("finish-before-L-rejected", func(t *testing.T) {
		dec, err := steim.NewDecoder(1, n, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(body[:len(body)-1]); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrTruncated) {
			t.Fatalf("want ErrTruncated, got %v", err)
		}
		if err := dec.Push(body[len(body)-1:]); !errors.Is(err, steim.ErrState) {
			t.Fatalf("want ErrState on reuse, got %v", err)
		}
	})

	t.Run("delivered-once", func(t *testing.T) {
		dec, err := steim.NewDecoder(1, n, len(body), math.MaxInt32)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Push(nil); err != nil {
			t.Fatalf("empty push should be accepted: %v", err)
		}
		if err := dec.Push(body); err != nil {
			t.Fatal(err)
		}
		if _, err := dec.Finish(); err != nil {
			t.Fatalf("first Finish: %v", err)
		}
		if err := dec.Push(nil); !errors.Is(err, steim.ErrState) {
			t.Fatalf("want ErrState from Push after delivery, got %v", err)
		}
		if _, err := dec.Finish(); !errors.Is(err, steim.ErrState) {
			t.Fatalf("want ErrState from second Finish, got %v", err)
		}
	})
}

func TestFewerThanNDifferencesRejected(t *testing.T) {
	// One 4x8 word gives 4 diffs, but ask for 5 samples: d0 exists yet
	// the stream still falls short of the required N differences.
	body, _ := buildFromSpecs(1, 3, []wordSpec{
		{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}},
	})
	dec, err := steim.NewDecoder(1, 5, len(body), math.MaxInt32)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Push(body); err != nil {
		t.Fatal(err)
	}
	if _, err := dec.Finish(); !errors.Is(err, steim.ErrCorrupt) {
		t.Fatalf("want ErrCorrupt, got %v", err)
	}
}

func TestMetadataValidation(t *testing.T) {
	cases := []struct {
		name                 string
		enc, n, length, maxN int
		want                 error
	}{
		{"bad-encoding", 3, 1, 64, 10, steim.ErrInvalidMetadata},
		{"zero-n", 1, 0, 64, 10, steim.ErrInvalidMetadata},
		{"zero-length", 1, 1, 0, 10, steim.ErrInvalidMetadata},
		{"length-not-multiple-of-64", 1, 1, 100, 10, steim.ErrInvalidMetadata},
		{"negative-length", 1, 1, -64, 10, steim.ErrInvalidMetadata},
		{"over-host-limit", 1, 11, 64, 10, steim.ErrOverflow},
		{"exact-limit-ok", 1, 10, 64, 10, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dec, err := steim.NewDecoder(tc.enc, tc.n, tc.length, tc.maxN)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
			if tc.want == nil && dec == nil {
				t.Fatal("expected decoder")
			}
		})
	}
}

func TestControlZeroPaddingIgnored(t *testing.T) {
	// Frame 0 word 4 is control 0 with arbitrary garbage payload and
	// must be ignored entirely; only word 3 carries differences.
	var controls [16]int
	controls[3] = 1
	var data [16]uint32
	data[3] = packWord([]int{8, 8, 8, 8}, []int64{1, 2, 3, 4}, 0, 32)
	data[4] = 0xDEADBEEF
	data[5] = 0x01020304
	body := buildRecord(9, 18, makeFrame(controls, data))
	got := deliver(t, 1, 4, body, math.MaxInt32, 1)
	assertValues(t, got, 9, []int64{2, 3, 4})
	assertRef(t, 1, 4, body, got)
}

func TestEveryByteBoundary(t *testing.T) {
	// Every legal-group-width record from TestLegalGroupWidths must
	// survive every possible chunk cut: fixed sizes 1..L, whole-body
	// pushes, and empty/interleaved arbitrary splits.
	encodings := []struct {
		enc   int
		specs []wordSpec
	}{
		{1, []wordSpec{{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}}}},
		{1, []wordSpec{{0, 3, 2, 0, []int{16, 16}, []int64{1, -2}}}},
		{1, []wordSpec{{0, 3, 3, 0, []int{32}, []int64{7}}}},
		{2, []wordSpec{{0, 3, 1, 0, []int{8, 8, 8, 8}, []int64{1, 2, 3, 4}}}},
		{2, []wordSpec{{0, 3, 2, 1, []int{30}, []int64{7}}}},
		{2, []wordSpec{{0, 3, 2, 2, []int{15, 15}, []int64{7, -8}}}},
		{2, []wordSpec{{0, 3, 2, 3, []int{10, 10, 10}, []int64{1, 2, 3}}}},
		{2, []wordSpec{{0, 3, 3, 0, []int{6, 6, 6, 6, 6}, []int64{1, 2, 3, 4, 5}}}},
		{2, []wordSpec{{0, 3, 3, 1, []int{5, 5, 5, 5, 5, 5}, []int64{1, 2, 3, 4, 5, 6}}}},
		{2, []wordSpec{{0, 3, 3, 2, []int{4, 4, 4, 4, 4, 4, 4}, []int64{1, 2, 3, 4, 5, 6, 7}}}},
	}

	for ri, rec := range encodings {
		body, n := buildFromSpecs(rec.enc, 42, rec.specs)

		baseline := deliver(t, rec.enc, n, body, math.MaxInt32, 0)
		assertRef(t, rec.enc, n, body, baseline)

		for chunk := 1; chunk <= len(body); chunk++ {
			got := deliver(t, rec.enc, n, body, math.MaxInt32, chunk)
			if len(got) != len(baseline) {
				t.Fatalf("record %d chunk %d: count mismatch", ri, chunk)
			}
			for i := range got {
				if got[i] != baseline[i] {
					t.Fatalf("record %d chunk %d sample %d: %+v != %+v",
						ri, chunk, i, got[i], baseline[i])
				}
			}
		}

		// Arbitrary splits with zero-length pushes interleaved.
		rest := len(body) - (1 + 2 + 3 + 5 + 8 + 13 + 21)
		split := deliverChunks(t, rec.enc, n, body,
			[]int{0, 1, 2, 0, 3, 5, 0, 8, 13, 21, rest})
		for i := range split {
			if split[i] != baseline[i] {
				t.Fatalf("record %d jagged split sample %d mismatch", ri, i)
			}
		}
	}
}
