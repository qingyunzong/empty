package lzw

import (
	"bytes"
	"errors"
	"math/rand"
	"testing"
)

// pack builds a stream from explicit codes and widths (test helper).
func pack(codes []int, widths []int) []byte {
	w := bitWriter{}
	for i, c := range codes {
		w.write(c, widths[i])
	}
	w.flush()
	return w.buf
}

func widths9(n int) []int {
	w := make([]int, n)
	for i := range w {
		w[i] = 9
	}
	return w
}

// naiveEncode is an independent encoder: string-keyed dictionary and its
// own bit packing, written only from the format specification. It must
// produce byte-identical output to Encode.
func naiveEncode(src []byte) []byte {
	if len(src) == 0 {
		return nil
	}
	freshDict := func() map[string]int {
		d := map[string]int{}
		for i := 0; i < 256; i++ {
			d[string([]byte{byte(i)})] = i
		}
		return d
	}
	dict := freshDict()
	next := FirstCode
	width := MinWidth
	var out []byte
	var acc uint64
	var nbits uint
	emit := func(code int) {
		acc |= uint64(code) << nbits
		nbits += uint(width)
		for nbits >= 8 {
			out = append(out, byte(acc))
			acc >>= 8
			nbits -= 8
		}
	}
	cur := string(src[:1])
	for _, b := range src[1:] {
		s := cur + string([]byte{b})
		if _, ok := dict[s]; ok {
			cur = s
			continue
		}
		emit(dict[cur])
		dict[s] = next
		next++
		if next == 1<<width && width < MaxWidth {
			width++
		}
		if next > MaxCode {
			emit(ClearCode)
			dict = freshDict()
			next = FirstCode
			width = MinWidth
		}
		cur = string([]byte{b})
	}
	emit(dict[cur])
	if nbits > 0 {
		out = append(out, byte(acc))
	}
	return out
}

func randomBytes(rnd *rand.Rand, n int) []byte {
	b := make([]byte, n)
	rnd.Read(b)
	return b
}

func TestRoundTrip(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))
	inputs := [][]byte{
		{},
		{0},
		{255},
		[]byte("a"),
		bytes.Repeat([]byte("a"), 1000),
		bytes.Repeat([]byte("ab"), 500),
		[]byte("TOBEORNOTTOBEORTOBEORNOT"),
		bytes.Repeat([]byte{0, 1, 2, 3}, 2000),
	}
	for _, n := range []int{1, 2, 7, 100, 4096, 100000} {
		inputs = append(inputs, randomBytes(rnd, n))
	}
	all := make([]byte, 0, 256*8)
	for r := 0; r < 8; r++ {
		for v := 0; v < 256; v++ {
			all = append(all, byte(v))
		}
	}
	inputs = append(inputs, all)
	for i, in := range inputs {
		dec, err := Decode(Encode(in))
		if err != nil {
			t.Fatalf("case %d (len %d): decode error: %v", i, len(in), err)
		}
		if !bytes.Equal(dec, in) {
			t.Fatalf("case %d (len %d): round trip mismatch", i, len(in))
		}
	}
}

func TestSelfReference(t *testing.T) {
	// 'a' then code 257, which is exactly the next unassigned code:
	// it decodes to prevString + firstByte(prevString) = "aa".
	dec, err := Decode(pack([]int{97, 257}, widths9(2)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(dec) != "aaa" {
		t.Fatalf("got %q, want %q", dec, "aaa")
	}
	// Chained self-reference: 257 then 258 (again the next code).
	dec, err = Decode(pack([]int{97, 257, 258}, widths9(3)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(dec) != "aaaaaa" {
		t.Fatalf("got %q, want %q", dec, "aaaaaa")
	}
	// Self-reference right after a clear code.
	dec, err = Decode(pack([]int{97, 257, ClearCode, 98, 257}, widths9(5)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(dec) != "aaabbb" {
		t.Fatalf("got %q, want %q", dec, "aaabbb")
	}
	// Highly repetitive data exercises the same path through the encoder.
	for _, s := range []string{"aaaaaa", "ababababab", "abcabcabcabcabc"} {
		dec, err := Decode(Encode([]byte(s)))
		if err != nil || string(dec) != s {
			t.Fatalf("round trip %q: got %q, err %v", s, dec, err)
		}
	}
}

func TestInvalidCode(t *testing.T) {
	cases := map[string][]byte{
		"first code not literal": pack([]int{300}, widths9(1)),
		"code beyond next":       pack([]int{97, 300}, widths9(2)),
		"skips next code":        pack([]int{97, 258}, widths9(2)),
		"garbage stream":         {0xff, 0xff, 0xff, 0xff},
	}
	for name, src := range cases {
		if _, err := Decode(src); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("%s: got err %v, want ErrInvalidCode", name, err)
		}
	}
}

func TestTrailingBits(t *testing.T) {
	enc := Encode([]byte("hello")) // 5 codes x 9 bits = 45 bits -> 6 bytes, 3 padding bits
	if got := len(enc); got != 6 {
		t.Fatalf("encoded length %d, want 6", got)
	}
	// 8 literal codes x 9 bits = 72 bits = 9 bytes exactly, no padding;
	// one extra byte leaves 8 leftover bits, too many for padding but
	// too few for a code.
	enc8 := pack([]int{97, 98, 99, 100, 101, 102, 103, 104}, widths9(8))
	if got := len(enc8); got != 9 {
		t.Fatalf("encoded length %d, want 9", got)
	}
	bad := append(append([]byte{}, enc8...), 0x00)
	if _, err := Decode(bad); !errors.Is(err, ErrTrailingBits) {
		t.Fatalf("extra zero byte: got %v, want ErrTrailingBits", err)
	}
	// Set one of the zero padding bits in the final byte.
	bad = append([]byte{}, enc...)
	bad[len(bad)-1] |= 0x80
	if _, err := Decode(bad); !errors.Is(err, ErrTrailingBits) {
		t.Fatalf("flipped padding bit: got %v, want ErrTrailingBits", err)
	}
	// Truncating mid-code leaves a partial code with non-zero bits
	// (the final code of "hello" is 111, whose low bits are set).
	bad = enc[:len(enc)-1]
	if _, err := Decode(bad); !errors.Is(err, ErrTrailingBits) {
		t.Fatalf("truncated: got %v, want ErrTrailingBits", err)
	}
}

func TestIndependentEncoder(t *testing.T) {
	rnd := rand.New(rand.NewSource(2))
	inputs := [][]byte{
		[]byte("TOBEORNOTTOBEORTOBEORNOT"),
		bytes.Repeat([]byte("xyz"), 3000),
		randomBytes(rnd, 1),
		randomBytes(rnd, 255),
		randomBytes(rnd, 70000),  // crosses several width boundaries
		randomBytes(rnd, 400000), // fills the dictionary, forces clear codes
	}
	for i, in := range inputs {
		got, want := Encode(in), naiveEncode(in)
		if !bytes.Equal(got, want) {
			t.Fatalf("case %d: encoders disagree (%d vs %d bytes)", i, len(got), len(want))
		}
		dec, err := Decode(want)
		if err != nil {
			t.Fatalf("case %d: decode of independent encoder output: %v", i, err)
		}
		if !bytes.Equal(dec, in) {
			t.Fatalf("case %d: independent encoder round trip mismatch", i)
		}
	}
}

func TestDictJustFull(t *testing.T) {
	// Seeded random data long enough to fill all 65536 dictionary slots,
	// forcing a clear code exactly when the next code would exceed 65535.
	in := randomBytes(rand.New(rand.NewSource(3)), 400000)
	tr, err := DecodeTrace(Encode(in))
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	clears := 0
	for i, c := range tr.Codes {
		if c != ClearCode {
			continue
		}
		clears++
		before, after := tr.Checkpoints[i], tr.Checkpoints[i+1]
		// The decoder lags the encoder by one entry, so at the clear
		// code its next unassigned code is MaxCode: the dictionary is
		// full as far as the encoder is concerned.
		if before.Next != MaxCode {
			t.Fatalf("clear at code %d: dictionary next=%d, want %d (just full)", i, before.Next, MaxCode)
		}
		if before.Width != MaxWidth {
			t.Fatalf("clear at code %d: width=%d, want %d", i, before.Width, MaxWidth)
		}
		if after.Next != FirstCode || after.Width != MinWidth {
			t.Fatalf("after clear at code %d: next=%d width=%d, want %d/%d",
				i, after.Next, after.Width, FirstCode, MinWidth)
		}
		if after.Generation != before.Generation+1 {
			t.Fatalf("clear at code %d: generation did not advance", i)
		}
		if after.Digest == before.Digest {
			t.Fatalf("clear at code %d: digest unchanged across clear", i)
		}
	}
	if clears == 0 {
		t.Fatal("expected at least one clear code")
	}
	t.Logf("clears=%d codes=%d", clears, len(tr.Codes))
	for i, w := range tr.Widths {
		if w < MinWidth || w > MaxWidth {
			t.Fatalf("code %d: width %d out of range", i, w)
		}
	}
}

func TestWidthGrowthBoundary(t *testing.T) {
	// Bytes 0..255: exactly 255 dictionary additions, so the next code
	// reaches 512 exactly at the final emission and the width grows 9->10.
	in := make([]byte, 256)
	for i := range in {
		in[i] = byte(i)
	}
	tr, err := DecodeTrace(Encode(in))
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	if len(tr.Codes) != 256 {
		t.Fatalf("got %d codes, want 256", len(tr.Codes))
	}
	for i, c := range tr.Codes {
		if c != i {
			t.Fatalf("code %d = %d, want %d", i, c, i)
		}
	}
	for i, w := range tr.Widths {
		want := 9
		if i == 255 {
			want = 10 // emitted after the next code hit 512
		}
		if w != want {
			t.Fatalf("code %d: width %d, want %d", i, w, want)
		}
	}
	// The checkpoint width flips exactly across the growth boundary.
	if tr.Checkpoints[254].Width != 9 || tr.Checkpoints[255].Width != 10 {
		t.Fatalf("checkpoint widths around boundary: %d, %d",
			tr.Checkpoints[254].Width, tr.Checkpoints[255].Width)
	}
	// Bit cursor advances by exactly the width of each code.
	for i, w := range tr.Widths {
		if got := tr.Checkpoints[i+1].BitPos - tr.Checkpoints[i].BitPos; got != w {
			t.Fatalf("code %d: bit advance %d, want %d", i, got, w)
		}
	}
}

func TestDictOverflow(t *testing.T) {
	// Remove the first clear code from a stream that fills the dictionary;
	// the decoder must then refuse to grow the dictionary past MaxCode.
	in := randomBytes(rand.New(rand.NewSource(4)), 400000)
	tr, err := DecodeTrace(Encode(in))
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	k := -1
	for i, c := range tr.Codes {
		if c == ClearCode {
			k = i
			break
		}
	}
	if k < 0 {
		t.Fatal("no clear code in stream")
	}
	codes := append(append([]int{}, tr.Codes[:k]...), tr.Codes[k+1:]...)
	widths := append(append([]int{}, tr.Widths[:k]...), tr.Widths[k+1:]...)
	// After the removal the decoder keeps its full dictionary, so the
	// following codes are read at MaxWidth instead of the reset width.
	for i := k; i < len(widths); i++ {
		widths[i] = MaxWidth
	}
	if _, err := Decode(pack(codes, widths)); !errors.Is(err, ErrDictOverflow) {
		t.Fatalf("got %v, want ErrDictOverflow", err)
	}
}
