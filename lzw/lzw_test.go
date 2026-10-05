package lzw

import (
	"bytes"
	stdlzw "compress/lzw"
	"errors"
	"io"
	"math/rand"
	"strings"
	"testing"
)

func stdEncode(t *testing.T, src []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := stdlzw.NewWriter(&buf, stdlzw.LSB, LitWidth)
	if _, err := w.Write(src); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func stdDecode(t *testing.T, data []byte) []byte {
	t.Helper()
	r := stdlzw.NewReader(bytes.NewReader(data), stdlzw.LSB, LitWidth)
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	return out
}

func testInputs() map[string][]byte {
	rng := rand.New(rand.NewSource(1))
	rnd := make([]byte, 64*1024)
	rng.Read(rnd)
	allBytes := make([]byte, 256*64)
	for i := range allBytes {
		allBytes[i] = byte(i)
	}
	return map[string][]byte{
		"empty":    {},
		"one":      {'x'},
		"same":     []byte(strings.Repeat("a", 1000)),
		"abab":     []byte(strings.Repeat("ab", 500)),
		"text":     []byte(strings.Repeat("the quick brown fox jumps over the lazy dog. ", 2000)),
		"random":   rnd,
		"allbytes": allBytes,
	}
}

func TestRoundTrip(t *testing.T) {
	for name, src := range testInputs() {
		out, err := Decode(Encode(src))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !bytes.Equal(out, src) {
			t.Fatalf("%s: round trip mismatch (%d vs %d bytes)", name, len(out), len(src))
		}
	}
}

// TestCrossVerifyStdlib checks both directions against the standard
// library, which acts as an independent encoder and decoder.
func TestCrossVerifyStdlib(t *testing.T) {
	for name, src := range testInputs() {
		if out := stdDecode(t, Encode(src)); !bytes.Equal(out, src) {
			t.Fatalf("%s: stdlib could not decode our stream", name)
		}
		if out, err := Decode(stdEncode(t, src)); err != nil || !bytes.Equal(out, src) {
			t.Fatalf("%s: we could not decode stdlib stream: %v", name, err)
		}
	}
}

// TestSelfReference feeds inputs whose code streams contain the
// code == hi case, where a code refers to the entry the decoder is just
// about to define (expansion of the previous code plus its head byte).
func TestSelfReference(t *testing.T) {
	for _, src := range [][]byte{
		[]byte("aaaa"),
		[]byte(strings.Repeat("a", 1000)),
		[]byte(strings.Repeat("ab", 500)),
		[]byte(strings.Repeat("abcabc", 300)),
	} {
		data := Encode(src)
		d := newDecoder(data)
		for {
			done, err := d.step(nil)
			if err != nil {
				t.Fatal(err)
			}
			if done {
				break
			}
		}
		if !d.selfRef {
			t.Fatalf("input of %d bytes produced no self-referential code", len(src))
		}
		out, err := Decode(data)
		if err != nil || !bytes.Equal(out, src) {
			t.Fatalf("round trip failed: %v", err)
		}
	}
}

// TestDictionaryJustFull uses random data, which fills the dictionary to
// its maximum of maxCode entries, forcing the encoder to emit clear
// codes; it checks the decoder observes the exactly-full dictionary.
func TestDictionaryJustFull(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	src := make([]byte, 400*1024)
	rng.Read(src)
	data := Encode(src)
	d := newDecoder(data)
	for {
		done, err := d.step(nil)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			break
		}
	}
	if d.maxHi != maxCode {
		t.Fatalf("max hi = %d, want exactly %d (dictionary just full)", d.maxHi, maxCode)
	}
	if d.clears < 2 {
		t.Fatalf("got %d clear codes, want at least 2 (initial + dictionary full)", d.clears)
	}
	out, err := Decode(data)
	if err != nil || !bytes.Equal(out, src) {
		t.Fatalf("round trip failed: %v", err)
	}
	if got := stdDecode(t, data); !bytes.Equal(got, src) {
		t.Fatal("stdlib disagrees on dictionary-full stream")
	}
}

func TestMissingEOF(t *testing.T) {
	w := &bitWriter{width: LitWidth + 1}
	w.write(ClearCode)
	w.write('h')
	w.write('i')
	w.flush()
	if _, err := Decode(w.buf); !errors.Is(err, ErrMissingEOF) {
		t.Fatalf("crafted stream: got %v, want ErrMissingEOF", err)
	}
	enc := Encode([]byte("hello world, hello world"))
	if _, err := Decode(enc[:len(enc)-1]); !errors.Is(err, ErrMissingEOF) {
		t.Fatalf("truncated stream: got %v, want ErrMissingEOF", err)
	}
	if _, err := Decode(nil); !errors.Is(err, ErrMissingEOF) {
		t.Fatalf("empty stream: got %v, want ErrMissingEOF", err)
	}
}

func TestInvalidCode(t *testing.T) {
	w := &bitWriter{width: LitWidth + 1}
	w.write(ClearCode)
	w.write('a')
	w.write(300) // hi is 258 here, so 300 was never defined
	w.write(EOFCode)
	w.flush()
	if _, err := Decode(w.buf); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("got %v, want ErrInvalidCode", err)
	}
}

func TestTrailingBits(t *testing.T) {
	w := &bitWriter{width: LitWidth + 1}
	w.write(ClearCode)
	w.write('x')
	w.write(EOFCode)
	w.flush()
	if _, err := Decode(w.buf); err != nil {
		t.Fatalf("clean stream: %v", err)
	}
	dirty := bytes.Clone(w.buf)
	dirty[len(dirty)-1] |= 0x08 // set the first padding bit after EOF
	if _, err := Decode(dirty); !errors.Is(err, ErrTrailingBits) {
		t.Fatalf("nonzero padding: got %v, want ErrTrailingBits", err)
	}
	extra := append(bytes.Clone(w.buf), 0)
	if _, err := Decode(extra); !errors.Is(err, ErrTrailingBits) {
		t.Fatalf("extra byte: got %v, want ErrTrailingBits", err)
	}
}

func encodeRandom(t *testing.T, seed int64, n int) ([]byte, []byte) {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	src := make([]byte, n)
	rng.Read(src)
	return src, Encode(src)
}

// TestPauseResume enumerates every possible pause position: decoding is
// checkpointed before every code, then resumed from that checkpoint to
// the end of the stream and compared against decoding from scratch.
func TestPauseResume(t *testing.T) {
	src, data := encodeRandom(t, 7, 3000)
	full, cps, err := DecodeCheckpoints(data)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(full, src) {
		t.Fatal("full decode mismatch")
	}
	for i := range cps {
		out, err := DecodeRange(data, i, -1, &cps[i])
		if err != nil {
			t.Fatalf("resume at code %d: %v", i, err)
		}
		if !bytes.Equal(out, full[cps[i].OutLen:]) {
			t.Fatalf("resume at code %d: output mismatch", i)
		}
	}
}

// TestRandomRanges decodes random code ranges, resuming from sparse
// checkpoints, and compares them with the corresponding slice of a full
// decode from scratch.
func TestRandomRanges(t *testing.T) {
	src, data := encodeRandom(t, 7, 3000)
	full, cps, err := DecodeCheckpoints(data)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(full, src) {
		t.Fatal("full decode mismatch")
	}
	var sparse []Checkpoint
	for i, cp := range cps {
		if i%7 == 0 {
			sparse = append(sparse, cp)
		}
	}
	rng := rand.New(rand.NewSource(9))
	for k := 0; k < 300; k++ {
		i := rng.Intn(len(cps))
		j := rng.Intn(len(cps))
		if i > j {
			i, j = j, i
		}
		out, err := DecodeRange(data, i, j, SelectCheckpoint(sparse, i))
		if err != nil {
			t.Fatalf("range [%d,%d): %v", i, j, err)
		}
		if want := full[cps[i].OutLen:cps[j].OutLen]; !bytes.Equal(out, want) {
			t.Fatalf("range [%d,%d): got %d bytes, want %d", i, j, len(out), len(want))
		}
	}
}

// TestWidthGrowthCheckpoints verifies that checkpoints land on both sides
// of every code-width growth and that ranges straddling the growth point
// decode correctly.
func TestWidthGrowthCheckpoints(t *testing.T) {
	_, data := encodeRandom(t, 7, 3000)
	full, cps, err := DecodeCheckpoints(data)
	if err != nil {
		t.Fatal(err)
	}
	trans := map[uint]int{}
	for i := 1; i < len(cps); i++ {
		if cps[i].Width != cps[i-1].Width {
			trans[cps[i].Width] = i
		}
	}
	for _, w := range []uint{10, 11, 12} {
		k, ok := trans[w]
		if !ok {
			t.Fatalf("no checkpoint observed across growth to width %d", w)
		}
		lo, hi := k-2, k+2
		out, err := DecodeRange(data, lo, hi, SelectCheckpoint(cps, lo))
		if err != nil {
			t.Fatalf("range across width %d growth: %v", w, err)
		}
		if want := full[cps[lo].OutLen:cps[hi].OutLen]; !bytes.Equal(out, want) {
			t.Fatalf("range across width %d growth: mismatch", w)
		}
	}
}

// TestCheckpointAtDictionaryFull resumes from checkpoints taken when the
// dictionary is exactly full (hi == maxCode), i.e. right before the
// encoder's clear code, and straddles the clear that follows.
func TestCheckpointAtDictionaryFull(t *testing.T) {
	_, data := encodeRandom(t, 42, 100*1024)
	full, cps, err := DecodeCheckpoints(data)
	if err != nil {
		t.Fatal(err)
	}
	tested := 0
	for i, cp := range cps {
		if cp.Hi != maxCode {
			continue
		}
		if i+1 >= len(cps) || cps[i+1].Hi != EOFCode || cps[i+1].Width != LitWidth+1 {
			t.Fatalf("code %d follows a just-full dictionary but is not a clear", cp.CodeIndex)
		}
		out, err := DecodeRange(data, cp.CodeIndex, -1, &cp)
		if err != nil || !bytes.Equal(out, full[cp.OutLen:]) {
			t.Fatalf("resume from just-full checkpoint at code %d: %v", cp.CodeIndex, err)
		}
		lo, hi := cp.CodeIndex-1, cp.CodeIndex+3
		out, err = DecodeRange(data, lo, hi, &cps[lo])
		if err != nil || !bytes.Equal(out, full[cps[lo].OutLen:cps[hi].OutLen]) {
			t.Fatalf("range straddling clear at code %d: %v", cp.CodeIndex, err)
		}
		if tested++; tested == 3 {
			break
		}
	}
	if tested == 0 {
		t.Fatal("no checkpoint with a just-full dictionary found")
	}
}

// TestCheckpointAcrossClear builds a stream with a clear code in the
// middle and shows that a checkpoint taken right after that clear (empty
// dictionary) cannot be replayed over a stream whose dictionary at the
// same bit position was built without the clear.
func TestCheckpointAcrossClear(t *testing.T) {
	w := &bitWriter{width: LitWidth + 1}
	for _, c := range []uint32{ClearCode, 'x', 'y', ClearCode, 'z', EOFCode} {
		w.write(c)
	}
	w.flush()
	full, cps, err := DecodeCheckpoints(w.buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(full) != "xyz" {
		t.Fatalf("full decode = %q", full)
	}
	cpPost := cps[4] // right after the mid-stream clear: empty dictionary
	out, err := DecodeRange(w.buf, 4, -1, &cpPost)
	if err != nil || string(out) != "z" {
		t.Fatalf("resume after clear: %q, %v", out, err)
	}

	w2 := &bitWriter{width: LitWidth + 1}
	for _, c := range []uint32{ClearCode, 'x', 'y', 'z', EOFCode} {
		w2.write(c)
	}
	w2.flush()
	if _, err := DecodeRange(w2.buf, 4, -1, &cpPost); !errors.Is(err, ErrCheckpoint) {
		t.Fatalf("old checkpoint applied across removed clear: got %v, want ErrCheckpoint", err)
	}
}

// TestCheckpointSrcPrefix shows that restore verifies the compressed
// source prefix: flipping a bit that lies inside the checkpoint's prefix
// (but past its bit cursor) is detected even though the re-derived
// decoder state still matches.
func TestCheckpointSrcPrefix(t *testing.T) {
	w := &bitWriter{width: LitWidth + 1}
	for _, c := range []uint32{ClearCode, 'a', 'b', 'c', EOFCode} {
		w.write(c)
	}
	w.flush()
	_, cps, err := DecodeCheckpoints(w.buf)
	if err != nil {
		t.Fatal(err)
	}
	cp := cps[1] // bitPos 9: prefix covers 2 bytes, including bits of code 1
	if cp.BitPos%8 == 0 {
		t.Fatal("test wants a checkpoint mid-byte")
	}
	tampered := bytes.Clone(w.buf)
	tampered[1] |= 0x04 // flip a bit of code 1, inside the checkpoint's prefix
	if _, err := DecodeRange(tampered, 1, -1, &cp); !errors.Is(err, ErrCheckpoint) {
		t.Fatalf("tampered source prefix: got %v, want ErrCheckpoint", err)
	}
	if _, err := DecodeRange(w.buf, 1, -1, &cp); err != nil {
		t.Fatalf("untampered source: %v", err)
	}
}

// TestCheckpointForeignStream shows a checkpoint from one stream cannot
// be applied to another stream.
func TestCheckpointForeignStream(t *testing.T) {
	_, dataA := encodeRandom(t, 1, 2000)
	_, dataB := encodeRandom(t, 2, 2000)
	_, cpsA, err := DecodeCheckpoints(dataA)
	if err != nil {
		t.Fatal(err)
	}
	cp := cpsA[len(cpsA)/2]
	if _, err := DecodeRange(dataB, cp.CodeIndex, -1, &cp); !errors.Is(err, ErrCheckpoint) {
		t.Fatalf("foreign checkpoint: got %v, want ErrCheckpoint", err)
	}
}
