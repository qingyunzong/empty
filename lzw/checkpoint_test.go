package lzw

import (
	"bytes"
	"errors"
	"math/rand"
	"testing"
)

func concatSegments(segs [][]byte) []byte {
	var out []byte
	for _, s := range segs {
		out = append(out, s...)
	}
	return out
}

// TestEnumeratePauses resumes from the checkpoint at every possible pause
// and checks the remainder of the stream decodes identically to a full
// decode. Covers clear codes, self-references and width growth.
func TestEnumeratePauses(t *testing.T) {
	// Small crafted stream: self-reference, clear code, fresh self-reference.
	crafted := pack([]int{97, 257, ClearCode, 98, 257}, widths9(5))
	// Encoded stream large enough to cross the 9->10 and 10->11 bit
	// width growth boundaries.
	encoded := Encode(randomBytes(rand.New(rand.NewSource(5)), 3000))
	for name, src := range map[string][]byte{"crafted": crafted, "encoded": encoded} {
		tr, err := DecodeTrace(src)
		if err != nil {
			t.Fatalf("%s: trace: %v", name, err)
		}
		full := concatSegments(tr.Segments)
		for i, cp := range tr.Checkpoints {
			got, err := Resume(src, cp, -1)
			if err != nil {
				t.Fatalf("%s: resume at code %d: %v", name, i, err)
			}
			if want := concatSegments(tr.Segments[i:]); !bytes.Equal(got, want) {
				t.Fatalf("%s: resume at code %d: got %d bytes, want %d", name, i, len(got), len(want))
			}
			// Bounded resume from the same checkpoint.
			for _, end := range []int{i, i + 1, i + 3} {
				if end > len(tr.Codes) {
					continue
				}
				got, err := Resume(src, cp, end)
				if err != nil {
					t.Fatalf("%s: resume [%d,%d): %v", name, i, end, err)
				}
				if want := concatSegments(tr.Segments[i:end]); !bytes.Equal(got, want) {
					t.Fatalf("%s: resume [%d,%d) mismatch", name, i, end)
				}
			}
		}
		if !bytes.Equal(full, mustDecode(t, src)) {
			t.Fatalf("%s: trace output differs from Decode", name)
		}
	}
}

func mustDecode(t *testing.T, src []byte) []byte {
	t.Helper()
	b, err := Decode(src)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return b
}

// TestCheckpointAcrossWidthGrowth checks checkpoints whose index falls
// immediately before and after a code-width growth boundary.
func TestCheckpointAcrossWidthGrowth(t *testing.T) {
	in := make([]byte, 256)
	for i := range in {
		in[i] = byte(i)
	}
	src := Encode(in)
	tr, err := DecodeTrace(src)
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	// Width grows between code 254 (9 bits) and code 255 (10 bits).
	for _, i := range []int{253, 254, 255, 256} {
		got, err := Resume(src, tr.Checkpoints[i], -1)
		if err != nil {
			t.Fatalf("resume at %d: %v", i, err)
		}
		if want := concatSegments(tr.Segments[i:]); !bytes.Equal(got, want) {
			t.Fatalf("resume at %d mismatch", i)
		}
	}
}

// TestRandomRanges decodes random code ranges of a stream that contains
// clear codes and width growth, and compares against a full decode.
func TestRandomRanges(t *testing.T) {
	in := randomBytes(rand.New(rand.NewSource(6)), 400000)
	src := Encode(in)
	tr, err := DecodeTrace(src)
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	n := len(tr.Codes)
	rnd := rand.New(rand.NewSource(7))
	for trial := 0; trial < 64; trial++ {
		start := rnd.Intn(n)
		end := start + rnd.Intn(n-start+1)
		got, err := DecodeRange(src, start, end)
		if err != nil {
			t.Fatalf("range [%d,%d): %v", start, end, err)
		}
		if want := concatSegments(tr.Segments[start:end]); !bytes.Equal(got, want) {
			t.Fatalf("range [%d,%d): got %d bytes, want %d", start, end, len(got), len(want))
		}
		// Same range via a checkpoint resume.
		got, err = Resume(src, tr.Checkpoints[start], end)
		if err != nil {
			t.Fatalf("resume range [%d,%d): %v", start, end, err)
		}
		if want := concatSegments(tr.Segments[start:end]); !bytes.Equal(got, want) {
			t.Fatalf("resume range [%d,%d) mismatch", start, end)
		}
	}
	// Full-range and empty-range edge cases.
	if got, _ := DecodeRange(src, 0, -1); !bytes.Equal(got, concatSegments(tr.Segments)) {
		t.Fatal("full range mismatch")
	}
	if got, _ := DecodeRange(src, 5, 5); len(got) != 0 {
		t.Fatal("empty range produced output")
	}
}

// TestCheckpointRejectsForeignPrefix: a checkpoint only validates against
// the exact source prefix it was taken from.
func TestCheckpointRejectsForeignPrefix(t *testing.T) {
	srcA := Encode(randomBytes(rand.New(rand.NewSource(8)), 50000))
	srcB := Encode(randomBytes(rand.New(rand.NewSource(9)), 50000))
	trA, err := DecodeTrace(srcA)
	if err != nil {
		t.Fatalf("trace A: %v", err)
	}
	for _, i := range []int{1, 2, 100, len(trA.Codes) / 2, len(trA.Codes) - 1} {
		cp := trA.Checkpoints[i]
		if _, err := Resume(srcA, cp, -1); err != nil {
			t.Fatalf("checkpoint %d rejected by its own stream: %v", i, err)
		}
		if _, err := Resume(srcB, cp, -1); !errors.Is(err, ErrCheckpointMismatch) {
			t.Fatalf("checkpoint %d accepted by foreign stream: %v", i, err)
		}
	}
	// Corrupting one source byte anywhere before the checkpoint index
	// must also be detected.
	cp := trA.Checkpoints[len(trA.Codes)/2]
	bad := append([]byte{}, srcA...)
	bad[3] ^= 0x40
	if _, err := Resume(bad, cp, -1); err == nil {
		t.Fatal("corrupted prefix accepted (decode may differ silently)")
	}
}

// TestCheckpointAcrossClear: a clear code resets the dictionary, so a
// checkpoint taken before the clear must never validate against the
// post-clear dictionary, and vice versa.
func TestCheckpointAcrossClear(t *testing.T) {
	// Stream A: codes [97, 98, clear, 99, 100]; checkpoint after the clear
	// belongs to generation 2 with a fresh dictionary.
	srcA := pack([]int{97, 98, ClearCode, 99, 100}, widths9(5))
	trA, err := DecodeTrace(srcA)
	if err != nil {
		t.Fatalf("trace A: %v", err)
	}
	preClear := trA.Checkpoints[2]  // after codes [97, 98], before clear
	postClear := trA.Checkpoints[4] // after codes [97, 98, clear, 99]
	if preClear.Generation == postClear.Generation {
		t.Fatal("generation did not change across clear")
	}
	// Stream B has the clear one code earlier; replaying its prefix to the
	// pre-clear checkpoint index lands on the post-clear dictionary.
	srcB := pack([]int{97, ClearCode, 98, 99, 100}, widths9(5))
	if _, err := Resume(srcB, preClear, -1); !errors.Is(err, ErrCheckpointMismatch) {
		t.Fatalf("pre-clear checkpoint accepted post-clear dictionary: %v", err)
	}
	// Stream C has no clear at all; the post-clear checkpoint must not fit.
	srcC := pack([]int{97, 98, 99, 100, 101}, widths9(5))
	if _, err := Resume(srcC, postClear, -1); !errors.Is(err, ErrCheckpointMismatch) {
		t.Fatalf("post-clear checkpoint accepted clear-free dictionary: %v", err)
	}
	// Sanity: both checkpoints resume their own stream correctly.
	if got, err := Resume(srcA, preClear, -1); err != nil || string(got) != "cd" {
		t.Fatalf("pre-clear resume: got %q err %v", got, err)
	}
	if got, err := Resume(srcA, postClear, -1); err != nil || string(got) != "d" {
		t.Fatalf("post-clear resume: got %q err %v", got, err)
	}
	// A checkpoint beyond the end of the stream is rejected.
	far := trA.Checkpoints[len(trA.Codes)]
	far.CodeIndex += 10
	if _, err := Resume(srcA, far, -1); !errors.Is(err, ErrCheckpointMismatch) {
		t.Fatalf("out-of-range checkpoint: %v", err)
	}
}
