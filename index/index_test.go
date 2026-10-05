package index

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// refScan is an independent full-scan reference implementation used to
// cross-check line references.
func refScan(data []byte) []LineRef {
	var refs []LineRef
	start := 0
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			refs = append(refs, refLine(len(refs)+1, data[start:i], int64(start), true))
			start = i + 1
		}
	}
	if start < len(data) {
		refs = append(refs, refLine(len(refs)+1, data[start:], int64(start), false))
	}
	return refs
}

func refLine(num int, line []byte, off int64, term bool) LineRef {
	sum := sha256.Sum256(line)
	return LineRef{Num: num, Offset: off, Length: len(line), Term: term, Digest: hex.EncodeToString(sum[:])}
}

// genLog builds a log of n lines with variable-length UTF-8 content
// (1-4 byte runes). If tailNL is false the last line is unterminated.
func genLog(rng *rand.Rand, n int, tailNL bool) []byte {
	runes := []rune("abcXYZ 0129中文字符测试éü🚀🎉αβγ—…")
	var b []byte
	for i := 0; i < n; i++ {
		l := rng.Intn(40)
		for j := 0; j < l; j++ {
			b = append(b, string(runes[rng.Intn(len(runes))])...)
		}
		if i < n-1 || tailNL {
			b = append(b, '\n')
		}
	}
	return b
}

func equalRefs(t *testing.T, got, want []LineRef) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("line count: got %d, want %d", len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("line %d: got %+v, want %+v", i+1, got[i], want[i])
		}
	}
}

func writeTemp(t *testing.T, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "test.log")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestScannerRandomChunking(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 50; trial++ {
		data := genLog(rng, rng.Intn(60), rng.Intn(2) == 0)
		rest := data
		s := NewScanner(0)
		for len(rest) > 0 {
			n := 1 + rng.Intn(1+rng.Intn(len(rest)+1)) // skewed random chunk size
			if n > len(rest) {
				n = len(rest)
			}
			s.Write(rest[:n])
			rest = rest[n:]
		}
		s.Finish()
		equalRefs(t, s.Lines, refScan(data))
	}
}

func TestRandomTruncation(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	full := genLog(rng, 200, true)
	for trial := 0; trial < 100; trial++ {
		n := rng.Intn(len(full) + 1)
		data := full[:n]
		s := NewScanner(0)
		s.Write(data)
		s.Finish()
		equalRefs(t, s.Lines, refScan(data))
	}
}

func TestBuildMatchesFullScan(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	for _, tailNL := range []bool{true, false} {
		data := genLog(rng, 500, tailNL)
		path := writeTemp(t, data)
		idx, err := Build(path)
		if err != nil {
			t.Fatal(err)
		}
		if idx.Size != int64(len(data)) {
			t.Fatalf("size: got %d, want %d", idx.Size, len(data))
		}
		sum := sha256.Sum256(data)
		if idx.Digest != hex.EncodeToString(sum[:]) {
			t.Fatal("digest mismatch")
		}
		equalRefs(t, idx.Lines, refScan(data))
	}
}

func TestAppendIncremental(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	for _, tailNL := range []bool{true, false} {
		orig := genLog(rng, 300, tailNL)
		path := writeTemp(t, orig)
		idx, err := Build(path)
		if err != nil {
			t.Fatal(err)
		}
		extra := genLog(rng, 120, rng.Intn(2) == 0)
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(extra); err != nil {
			t.Fatal(err)
		}
		f.Close()

		updated, err := Update(idx)
		if err != nil {
			t.Fatal(err)
		}
		fresh, err := Build(path)
		if err != nil {
			t.Fatal(err)
		}
		if updated.Digest != fresh.Digest || updated.Size != fresh.Size {
			t.Fatal("incremental update diverged from full rebuild")
		}
		equalRefs(t, updated.Lines, fresh.Lines)
		equalRefs(t, updated.Lines, refScan(append(append([]byte{}, orig...), extra...)))
	}
}

func TestModifyOriginalRejected(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	data := genLog(rng, 100, true)
	path := writeTemp(t, data)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	// Flip one byte inside the originally indexed region, then append.
	mut := append([]byte{}, data...)
	mut[len(mut)/2] ^= 0xFF
	mut = append(mut, []byte("new line\n")...)
	if err := os.WriteFile(path, mut, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Update(idx); !errors.Is(err, ErrStale) {
		t.Fatalf("expected ErrStale, got %v", err)
	}
}

func TestTruncateRejected(t *testing.T) {
	rng := rand.New(rand.NewSource(6))
	data := genLog(rng, 100, true)
	path := writeTemp(t, data)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, int64(len(data)/2)); err != nil {
		t.Fatal(err)
	}
	if _, err := Update(idx); !errors.Is(err, ErrStale) {
		t.Fatalf("expected ErrStale, got %v", err)
	}
}

func TestSearchVerifiesDigest(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	data := genLog(rng, 200, true)
	data = append(data, []byte("needle 关键词 here\nanother needle\n")...)
	path := writeTemp(t, data)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}

	matches, err := Search(idx, []byte("needle"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 2 {
		t.Fatalf("got %d matches, want 2", len(matches))
	}
	// Cross-check reported positions against the full-scan reference.
	refs := refScan(data)
	for i, m := range matches {
		want := refs[len(refs)-2+i]
		if m.Offset != want.Offset || m.Length != want.Length || m.Num != want.Num {
			t.Fatalf("match %d: got %+v, want position %+v", i, m.LineRef, want)
		}
		if string(data[m.Offset:m.Offset+int64(m.Length)]) != m.Text {
			t.Fatal("match text does not match source bytes")
		}
	}

	// Modify an original segment in place (same length): the recorded
	// digest no longer matches the source and search must refuse.
	mut := append([]byte{}, data...)
	mut[10] ^= 0xFF
	if err := os.WriteFile(path, mut, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Search(idx, []byte("needle")); !errors.Is(err, ErrStale) {
		t.Fatalf("expected ErrStale, got %v", err)
	}
}

func TestSaveLoadRoundtrip(t *testing.T) {
	rng := rand.New(rand.NewSource(8))
	data := genLog(rng, 50, false)
	path := writeTemp(t, data)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	ip := filepath.Join(t.TempDir(), "test.lidx")
	if err := Save(idx, ip); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(ip)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Digest != idx.Digest || loaded.Size != idx.Size {
		t.Fatal("roundtrip mismatch")
	}
	equalRefs(t, loaded.Lines, idx.Lines)
}
