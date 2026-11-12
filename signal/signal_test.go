package signal

import (
	"errors"
	"math/big"
	"testing"
)

func setBit(frame []byte, pos int) {
	if pos < 0 {
		panic("negative bit")
	}
	frame[pos/8] |= 1 << uint(pos%8)
}

func setRaw(frame []byte, positions []int, value uint64) {
	for bit, pos := range positions {
		if value&(1<<bit) != 0 {
			setBit(frame, pos)
		}
	}
}

func findSignal(t *testing.T, out *DecodedFrame, name string) DecodedSignal {
	t.Helper()
	for _, sig := range out.Signals {
		if sig.Name == name {
			return sig
		}
	}
	t.Fatalf("signal %q not decoded; got %+v", name, out.Signals)
	return DecodedSignal{}
}

func assertNotDecoded(t *testing.T, out *DecodedFrame, name string) {
	t.Helper()
	for _, sig := range out.Signals {
		if sig.Name == name {
			t.Fatalf("inactive signal %q was decoded", name)
		}
	}
}

// TestDecodeCrossByte covers cross-byte assembly, mutually exclusive signed
// and unsigned signals sharing the same segment, exact rational values, bit
// provenance and garbage bits outside the active segments.
func TestDecodeCrossByte(t *testing.T) {
	tempBits := []Bit{{0, 3}, {0, 4}, {0, 5}, {0, 6}, {0, 7}, {1, 0}, {1, 1}, {1, 2}}
	tempPositions := []int{3, 4, 5, 6, 7, 8, 9, 10}

	pattern := Pattern{
		FrameID: 0x100,
		Length:  4,
		Signals: []Signal{
			{Name: "mux", Bits: []Bit{{0, 0}, {0, 1}, {0, 2}}, Scale: Rational{1, 1}},
			{
				Name: "temp", Bits: tempBits, Signed: true,
				Scale: Rational{1, 10}, Selector: "mux", Equals: 1,
			},
			{
				Name: "pressure", Bits: tempBits,
				Scale: Rational{1, 4}, Offset: Rational{1, 2},
				Selector: "mux", Equals: 2,
			},
			{Name: "counter", Bits: []Bit{{2, 0}, {2, 1}, {2, 2}, {2, 3}}, Scale: Rational{1, 1}},
		},
	}
	compiled, err := pattern.Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	t.Run("signed branch with garbage bits", func(t *testing.T) {
		frame := make([]byte, 4)
		setRaw(frame, tempPositions, 0x80) // assembled -128 once sign extended
		setRaw(frame, []int{16, 17, 18, 19}, 10)
		setBit(frame, 0) // mux = 1
		for pos := 0; pos < 32; pos++ {
			if pos <= 10 || (pos >= 16 && pos <= 19) {
				continue
			}
			setBit(frame, pos) // inactive garbage, including shared pressure bits
		}

		out, err := compiled.Decode(frame)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(out.Signals) != 3 {
			t.Fatalf("got %d active signals, want 3: %+v", len(out.Signals), out.Signals)
		}
		assertNotDecoded(t, out, "pressure")

		mux := findSignal(t, out, "mux")
		if mux.Raw.Cmp(big.NewInt(1)) != 0 {
			t.Fatalf("mux raw = %v, want 1", mux.Raw)
		}
		if mux.Value.Cmp(big.NewRat(1, 1)) != 0 {
			t.Fatalf("mux value = %v, want 1", mux.Value)
		}

		temp := findSignal(t, out, "temp")
		if temp.Raw.Cmp(big.NewInt(-128)) != 0 {
			t.Fatalf("temp raw = %v, want -128", temp.Raw)
		}
		if temp.Value.Cmp(big.NewRat(-64, 5)) != 0 { // -128/10 = -12.8
			t.Fatalf("temp value = %v, want -64/5", temp.Value)
		}
		if len(temp.Sources) != 8 {
			t.Fatalf("temp sources = %d, want 8", len(temp.Sources))
		}
		if src := temp.Sources[0]; src != (BitSource{AssembledBit: 0, ByteIndex: 0, BitInByte: 3}) {
			t.Fatalf("temp source[0] = %+v", src)
		}
		if src := temp.Sources[7]; src != (BitSource{AssembledBit: 7, ByteIndex: 1, BitInByte: 2}) {
			t.Fatalf("temp source[7] = %+v, want byte1 bit2", src)
		}

		counter := findSignal(t, out, "counter")
		if counter.Raw.Cmp(big.NewInt(10)) != 0 || counter.Value.Cmp(big.NewRat(10, 1)) != 0 {
			t.Fatalf("counter raw=%v value=%v, want 10", counter.Raw, counter.Value)
		}
	})

	t.Run("unsigned branch with offset", func(t *testing.T) {
		frame := make([]byte, 4)
		setRaw(frame, tempPositions, 200) // 0xC8
		setRaw(frame, []int{16, 17, 18, 19}, 10)
		setBit(frame, 1) // mux = 2

		out, err := compiled.Decode(frame)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		assertNotDecoded(t, out, "temp")
		if len(out.Signals) != 3 {
			t.Fatalf("got %d active signals, want 3", len(out.Signals))
		}

		pressure := findSignal(t, out, "pressure")
		if pressure.Raw.Cmp(big.NewInt(200)) != 0 {
			t.Fatalf("pressure raw = %v, want 200", pressure.Raw)
		}
		// 200 * 1/4 + 1/2 = 50.5 = 101/2
		if pressure.Value.Cmp(big.NewRat(101, 2)) != 0 {
			t.Fatalf("pressure value = %v, want 101/2", pressure.Value)
		}
	})
}

func TestSignedEndpoints(t *testing.T) {
	pattern := Pattern{
		FrameID: 7,
		Length:  2,
		Signals: []Signal{
			{Name: "mux", Bits: []Bit{{0, 0}, {0, 1}}, Scale: Rational{1, 1}},
			{Name: "s8", Bits: []Bit{{1, 0}, {1, 1}, {1, 2}, {1, 3}, {1, 4}, {1, 5}, {1, 6}, {1, 7}},
				Signed: true, Scale: Rational{1, 1}},
		},
	}
	compiled, err := pattern.Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	cases := []struct {
		raw  byte
		want int64
	}{
		{0x7F, 127},
		{0x80, -128},
		{0xFF, -1},
		{0x00, 0},
	}
	for _, tc := range cases {
		out, err := compiled.Decode([]byte{0, tc.raw})
		if err != nil {
			t.Fatalf("decode %#x: %v", tc.raw, err)
		}
		got := findSignal(t, out, "s8")
		if got.Raw.Cmp(big.NewInt(tc.want)) != 0 {
			t.Errorf("raw %#x: decoded %v, want %d", tc.raw, got.Raw, tc.want)
		}
	}

	// Signed four-bit minimum through a fractional scale and offset:
	// -8 * 1/2 + 3/4 = -13/4.
	narrow := Pattern{
		FrameID: 8,
		Length:  1,
		Signals: []Signal{
			{Name: "nibble", Bits: []Bit{{0, 4}, {0, 5}, {0, 6}, {0, 7}},
				Signed: true, Scale: Rational{1, 2}, Offset: Rational{3, 4}},
		},
	}
	nc, err := narrow.Compile()
	if err != nil {
		t.Fatalf("compile narrow: %v", err)
	}
	out, err := nc.Decode([]byte{0x80}) // high nibble 1000 -> -8
	if err != nil {
		t.Fatalf("decode narrow: %v", err)
	}
	nib := findSignal(t, out, "nibble")
	if nib.Raw.Cmp(big.NewInt(-8)) != 0 || nib.Value.Cmp(big.NewRat(-13, 4)) != 0 {
		t.Fatalf("nibble raw=%v value=%v, want -8 and -13/4", nib.Raw, nib.Value)
	}
}

func TestInactiveGarbageBits(t *testing.T) {
	segment := []Bit{{0, 2}, {0, 3}, {0, 4}, {0, 5}, {0, 6}, {0, 7}, {1, 0}, {1, 1}}
	pattern := Pattern{
		FrameID: 9,
		Length:  2,
		Signals: []Signal{
			{Name: "mux", Bits: []Bit{{0, 0}, {0, 1}}, Scale: Rational{1, 1}},
			{Name: "a", Bits: segment, Scale: Rational{1, 1}, Selector: "mux", Equals: 1},
			{Name: "b", Bits: segment, Scale: Rational{1, 1}, Selector: "mux", Equals: 2},
		},
	}
	compiled, err := pattern.Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	frame := []byte{0xFF, 0xFF} // everything set: mux region, segment and garbage
	frame[0] &^= 0b11           // clear selector region, then select mux = 1
	setBit(frame, 0)
	out, err := compiled.Decode(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Signals) != 2 {
		t.Fatalf("got %d signals, want mux+a only", len(out.Signals))
	}
	assertNotDecoded(t, out, "b")
	a := findSignal(t, out, "a")
	if a.Raw.Cmp(big.NewInt(0xFF)) != 0 { // shared segment is untouched by selector clearing
		t.Fatalf("a raw = %v, want 255", a.Raw)
	}
}

func TestBitOrderingLSBFirst(t *testing.T) {
	// Deliberately non-ascending positions: assembled bit 0 comes from frame
	// bit 11, bit 1 from frame bit 3, bit 2 from frame bit 8.
	pattern := Pattern{
		FrameID: 3,
		Length:  2,
		Signals: []Signal{
			{Name: "scrambled", Bits: []Bit{{1, 3}, {0, 3}, {1, 0}}, Scale: Rational{1, 1}},
		},
	}
	compiled, err := pattern.Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	frame := make([]byte, 2)
	setBit(frame, 3) // only assembled bit 1 is set -> value 2

	out, err := compiled.Decode(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	sig := findSignal(t, out, "scrambled")
	if sig.Raw.Cmp(big.NewInt(2)) != 0 {
		t.Fatalf("raw = %v, want 2", sig.Raw)
	}
	wantSources := []BitSource{
		{AssembledBit: 0, ByteIndex: 1, BitInByte: 3},
		{AssembledBit: 1, ByteIndex: 0, BitInByte: 3},
		{AssembledBit: 2, ByteIndex: 1, BitInByte: 0},
	}
	if len(sig.Sources) != len(wantSources) {
		t.Fatalf("sources = %+v", sig.Sources)
	}
	for i, want := range wantSources {
		if sig.Sources[i] != want {
			t.Fatalf("source[%d] = %+v, want %+v", i, sig.Sources[i], want)
		}
	}
}

func TestValidationRejections(t *testing.T) {
	base := func(signals []Signal) Pattern {
		return Pattern{FrameID: 1, Length: 2, Signals: signals}
	}

	cases := []struct {
		name    string
		pattern Pattern
		want    error
	}{
		{
			name:    "non-positive length",
			pattern: Pattern{FrameID: 1, Length: 0, Signals: []Signal{{Name: "x", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}}}},
			want:    ErrConfig,
		},
		{
			name:    "no signals",
			pattern: Pattern{FrameID: 1, Length: 2},
			want:    ErrConfig,
		},
		{
			name: "unnamed signal",
			pattern: base([]Signal{
				{Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}},
			}),
			want: ErrConfig,
		},
		{
			name: "duplicate signal name",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}},
				{Name: "x", Bits: []Bit{{0, 1}}, Scale: Rational{1, 1}},
			}),
			want: ErrConfig,
		},
		{
			name: "empty bit segment",
			pattern: base([]Signal{
				{Name: "x", Bits: nil, Scale: Rational{1, 1}},
			}),
			want: ErrConfig,
		},
		{
			name: "bit beyond frame",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{2, 0}}, Scale: Rational{1, 1}},
			}),
			want: ErrOutOfRange,
		},
		{
			name: "negative byte index",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{-1, 0}}, Scale: Rational{1, 1}},
			}),
			want: ErrOutOfRange,
		},
		{
			name: "bit offset beyond byte",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{0, 8}}, Scale: Rational{1, 1}},
			}),
			want: ErrOutOfRange,
		},
		{
			name: "repeated position inside signal",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{0, 3}, {1, 0}, {0, 3}}, Scale: Rational{1, 1}},
			}),
			want: ErrDuplicateBits,
		},
		{
			name: "unconditional overlap",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{0, 0}, {0, 1}}, Scale: Rational{1, 1}},
				{Name: "y", Bits: []Bit{{0, 1}, {0, 2}}, Scale: Rational{1, 1}},
			}),
			want: ErrOverlap,
		},
		{
			name: "selector overlap with unconditional signal",
			pattern: base([]Signal{
				{Name: "mux", Bits: []Bit{{0, 0}, {0, 1}}, Scale: Rational{1, 1}},
				{Name: "a", Bits: []Bit{{0, 1}}, Scale: Rational{1, 1}, Selector: "mux", Equals: 1},
			}),
			want: ErrOverlap,
		},
		{
			name: "same selector same value overlap",
			pattern: base([]Signal{
				{Name: "mux", Bits: []Bit{{0, 0}, {0, 1}}, Scale: Rational{1, 1}},
				{Name: "a", Bits: []Bit{{1, 0}}, Scale: Rational{1, 1}, Selector: "mux", Equals: 1},
				{Name: "b", Bits: []Bit{{1, 0}}, Scale: Rational{1, 1}, Selector: "mux", Equals: 1},
			}),
			want: ErrOverlap,
		},
		{
			name: "different selectors overlap",
			pattern: Pattern{FrameID: 1, Length: 3, Signals: []Signal{
				{Name: "m1", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}},
				{Name: "m2", Bits: []Bit{{0, 1}}, Scale: Rational{1, 1}},
				{Name: "a", Bits: []Bit{{1, 0}}, Scale: Rational{1, 1}, Selector: "m1", Equals: 1},
				{Name: "b", Bits: []Bit{{1, 0}}, Scale: Rational{1, 1}, Selector: "m2", Equals: 1},
			}},
			want: ErrOverlap,
		},
		{
			name: "missing selector",
			pattern: base([]Signal{
				{Name: "a", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}, Selector: "ghost", Equals: 1},
			}),
			want: ErrSelector,
		},
		{
			name: "signed selector",
			pattern: base([]Signal{
				{Name: "mux", Bits: []Bit{{0, 0}}, Signed: true, Scale: Rational{1, 1}},
				{Name: "a", Bits: []Bit{{0, 1}}, Scale: Rational{1, 1}, Selector: "mux", Equals: 1},
			}),
			want: ErrSelector,
		},
		{
			name: "conditional selector",
			pattern: Pattern{FrameID: 1, Length: 3, Signals: []Signal{
				{Name: "m0", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}},
				{Name: "m1", Bits: []Bit{{0, 1}}, Scale: Rational{1, 1}, Selector: "m0", Equals: 1},
				{Name: "a", Bits: []Bit{{1, 0}}, Scale: Rational{1, 1}, Selector: "m1", Equals: 1},
			}},
			want: ErrSelector,
		},
		{
			name: "selector cycle",
			pattern: Pattern{FrameID: 1, Length: 2, Signals: []Signal{
				{Name: "a", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}, Selector: "b", Equals: 1},
				{Name: "b", Bits: []Bit{{0, 1}}, Scale: Rational{1, 1}, Selector: "a", Equals: 1},
			}},
			want: ErrCycle,
		},
		{
			name: "zero denominator scale",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{0, 0}}, Scale: Rational{1, 0}},
			}),
			want: ErrRational,
		},
		{
			name: "zero denominator offset",
			pattern: base([]Signal{
				{Name: "x", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}, Offset: Rational{5, 0}},
			}),
			want: ErrRational,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.pattern.Compile()
			if !errors.Is(err, tc.want) {
				t.Fatalf("Compile() error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestDecodeFrameLength(t *testing.T) {
	compiled, err := Pattern{
		FrameID: 4,
		Length:  2,
		Signals: []Signal{
			{Name: "x", Bits: []Bit{{0, 0}, {0, 1}}, Scale: Rational{1, 1}},
		},
	}.Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if _, err := compiled.Decode([]byte{0}); !errors.Is(err, ErrFrameLength) {
		t.Fatalf("short frame error = %v, want ErrFrameLength", err)
	}
	if _, err := compiled.Decode([]byte{0, 0, 0}); !errors.Is(err, ErrFrameLength) {
		t.Fatalf("long frame error = %v, want ErrFrameLength", err)
	}
}

func TestRuntimeOverlapGuard(t *testing.T) {
	compiled, err := Pattern{
		FrameID: 5,
		Length:  1,
		Signals: []Signal{
			{Name: "x", Bits: []Bit{{0, 0}}, Scale: Rational{1, 1}},
			{Name: "y", Bits: []Bit{{0, 1}}, Scale: Rational{1, 1}},
		},
	}.Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	// Tamper with the validated structure to force a runtime collision.
	compiled.signals[1].positions = []int{0}

	if err := checkActiveOverlap(compiled.signals); !errors.Is(err, ErrOverlap) {
		t.Fatalf("checkActiveOverlap error = %v, want ErrOverlap", err)
	}
}

func TestRationalRat(t *testing.T) {
	got, err := (Rational{Num: 3, Den: 6}).Rat()
	if err != nil {
		t.Fatalf("Rat: %v", err)
	}
	if got.Cmp(big.NewRat(1, 2)) != 0 {
		t.Fatalf("Rat = %s, want 1/2", got.RatString())
	}
	if _, err := (Rational{Num: 1, Den: 0}).Rat(); !errors.Is(err, ErrRational) {
		t.Fatalf("zero denominator error = %v, want ErrRational", err)
	}
}
