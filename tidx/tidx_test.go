package tidx

import (
	"bytes"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// sampleLines mixes ASCII, multi-byte UTF-8 (CJK + emoji), and a final
// line without a trailing newline.
func sampleLines() []string {
	return []string{
		"2026-10-05T08:00:00Z INFO boot\n",
		"2026-10-05T08:00:01Z INFO 轨迹追踪启动 🚀\n",
		"2026-10-05T08:00:02Z DEBUG 用户=张三 动作=查询 结果=成功\n",
		"2026-10-05T08:00:03Z WARN  磁盘使用率 87% ⚠️\n",
		"2026-10-05T08:00:04Z INFO こんにちは世界\n",
		"2026-10-05T08:00:05Z ERROR 末行无换行", // no trailing newline
	}
}

func sampleBytes() []byte {
	var b bytes.Buffer
	for _, l := range sampleLines() {
		b.WriteString(l)
	}
	return b.Bytes()
}

// lineContaining returns the offset of the line that contains byte
// position p, where a position exactly on a boundary belongs to the line
// starting there.
func lineContaining(t *testing.T, idx *Index, p uint64) uint64 {
	t.Helper()
	for _, rec := range idx.Lines {
		if rec.Offset+uint64(rec.Length) > p {
			return rec.Offset
		}
	}
	t.Fatalf("no line contains position %d", p)
	return 0
}

func buildSample(t *testing.T) (*Index, []byte) {
	t.Helper()
	content := sampleBytes()
	idx, err := Build(bytes.NewReader(content))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return idx, content
}

func TestBuildOffsetsAndDigests(t *testing.T) {
	idx, content := buildSample(t)
	if idx.FileSize != uint64(len(content)) {
		t.Fatalf("FileSize=%d want %d", idx.FileSize, len(content))
	}
	if idx.LineCount() != uint64(len(sampleLines())) {
		t.Fatalf("LineCount=%d want %d", idx.LineCount(), len(sampleLines()))
	}
	var off uint64
	var prev [DigestSize]byte
	for i, l := range sampleLines() {
		rec := idx.Lines[i]
		if rec.Offset != off || uint64(rec.Length) != uint64(len(l)) {
			t.Fatalf("line %d: got (%d,%d) want (%d,%d)", i, rec.Offset, rec.Length, off, len(l))
		}
		want := sha256.Sum256(append(prev[:], l...))
		if rec.Digest != want {
			t.Fatalf("line %d: digest mismatch", i)
		}
		prev = want
		off += uint64(len(l))
	}
	if idx.FinalDigest != prev {
		t.Fatal("FinalDigest mismatch")
	}
}

func TestVerifyOK(t *testing.T) {
	idx, content := buildSample(t)
	res, err := Verify(bytes.NewReader(content), idx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Reason != OK || res.TrustedLines != idx.LineCount() || res.FirstUntrusted != idx.FileSize {
		t.Fatalf("got %+v", res)
	}
}

func TestEncodeDecodeRoundtrip(t *testing.T) {
	idx, _ := buildSample(t)
	got, err := Decode(idx.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if got.FileSize != idx.FileSize || got.FinalDigest != idx.FinalDigest ||
		got.LineCount() != idx.LineCount() {
		t.Fatal("header mismatch")
	}
	for i := range idx.Lines {
		if got.Lines[i] != idx.Lines[i] {
			t.Fatalf("line %d record mismatch", i)
		}
	}
	if _, err := Decode([]byte("nope")); err == nil {
		t.Fatal("expected error for short input")
	}
	bad := idx.Encode()
	copy(bad[0:4], "XXXX")
	if _, err := Decode(bad); err == nil {
		t.Fatal("expected error for bad magic")
	}
}

func TestTruncationFirstUntrustedInterval(t *testing.T) {
	idx, content := buildSample(t)
	size := uint64(len(content))
	// Cut points: exact line boundaries, mid-line, mid-multi-byte-rune,
	// and empty file.
	cuts := []uint64{0, 1, size - 1, size / 2}
	for _, rec := range idx.Lines {
		cuts = append(cuts, rec.Offset)                      // boundary
		cuts = append(cuts, rec.Offset+1)                    // just inside
		cuts = append(cuts, rec.Offset+uint64(rec.Length)-1) // last byte of line
	}
	for _, p := range cuts {
		if p >= size {
			continue
		}
		truncated := content[:p]
		inc, err := Verify(bytes.NewReader(truncated), idx)
		if err != nil {
			t.Fatalf("cut %d: %v", p, err)
		}
		full, err := FullScan(bytes.NewReader(truncated), idx)
		if err != nil {
			t.Fatalf("cut %d full: %v", p, err)
		}
		if inc.Reason != Truncated {
			t.Fatalf("cut %d: reason=%s want truncated", p, inc.Reason)
		}
		want := lineContaining(t, idx, p)
		if inc.FirstUntrusted != want {
			t.Fatalf("cut %d: first untrusted=%d want %d", p, inc.FirstUntrusted, want)
		}
		if !EqualTrust(inc, full) {
			t.Fatalf("cut %d: incremental %+v disagrees with full scan %+v", p, inc, full)
		}
	}
}

func TestModificationFirstUntrustedInterval(t *testing.T) {
	idx, content := buildSample(t)
	size := uint64(len(content))
	positions := []uint64{0, 1, size / 3, size / 2, size - 1}
	for _, rec := range idx.Lines {
		positions = append(positions, rec.Offset, rec.Offset+uint64(rec.Length)-1)
	}
	for _, p := range positions {
		mut := append([]byte(nil), content...)
		mut[p] ^= 0xFF // arbitrary byte flip, may create/destroy newlines
		inc, err := Verify(bytes.NewReader(mut), idx)
		if err != nil {
			t.Fatalf("pos %d: %v", p, err)
		}
		full, err := FullScan(bytes.NewReader(mut), idx)
		if err != nil {
			t.Fatalf("pos %d full: %v", p, err)
		}
		if inc.Reason != Modified {
			t.Fatalf("pos %d: reason=%s want modified", p, inc.Reason)
		}
		want := lineContaining(t, idx, p)
		if inc.FirstUntrusted != want {
			t.Fatalf("pos %d: first untrusted=%d want %d", p, inc.FirstUntrusted, want)
		}
		if !EqualTrust(inc, full) {
			t.Fatalf("pos %d: incremental %+v disagrees with full scan %+v", p, inc, full)
		}
		if full.Mismatches < 1 {
			t.Fatalf("pos %d: full scan found no mismatch", p)
		}
	}
}

func TestAppendedTail(t *testing.T) {
	// Content ends with a newline, so appended bytes are purely additive.
	content := []byte("alpha\nbeta 测试\ngamma\n")
	idx, err := Build(bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	grown := append(append([]byte(nil), content...), "new line 新增\n"...)
	inc, err := Verify(bytes.NewReader(grown), idx)
	if err != nil {
		t.Fatal(err)
	}
	full, err := FullScan(bytes.NewReader(grown), idx)
	if err != nil {
		t.Fatal(err)
	}
	if inc.Reason != Appended || inc.FirstUntrusted != idx.FileSize {
		t.Fatalf("got %+v", inc)
	}
	if inc.TrustedLines != idx.LineCount() {
		t.Fatalf("trusted lines=%d want %d", inc.TrustedLines, idx.LineCount())
	}
	if !EqualTrust(inc, full) {
		t.Fatalf("incremental %+v disagrees with full scan %+v", inc, full)
	}
}

func TestAppendAfterMissingNewlineReportsModified(t *testing.T) {
	// The indexed file's last line has no trailing newline, so appended
	// bytes extend that line: the honest verdict is "modified" at the
	// last line's offset, not "appended".
	idx, content := buildSample(t)
	grown := append(append([]byte(nil), content...), " more 数据\n"...)
	res, err := Verify(bytes.NewReader(grown), idx)
	if err != nil {
		t.Fatal(err)
	}
	last := idx.Lines[idx.LineCount()-1]
	if res.Reason != Modified || res.FirstUntrusted != last.Offset {
		t.Fatalf("got %+v", res)
	}
	full, err := FullScan(bytes.NewReader(grown), idx)
	if err != nil {
		t.Fatal(err)
	}
	if !EqualTrust(res, full) {
		t.Fatalf("incremental %+v disagrees with full scan %+v", res, full)
	}
}

func TestEmptyFile(t *testing.T) {
	idx, err := Build(strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	if idx.FileSize != 0 || idx.LineCount() != 0 {
		t.Fatalf("got %+v", idx)
	}
	res, err := Verify(strings.NewReader(""), idx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Reason != OK {
		t.Fatalf("got %+v", res)
	}
}

func TestLongLineStreaming(t *testing.T) {
	// One 8 MiB line (>> 32 KiB scan buffer) of multi-byte text, then a
	// normal line, then a final line without newline.
	var sb strings.Builder
	chunk := "长行片段🚀"
	for sb.Len() < 8<<20 {
		sb.WriteString(chunk)
	}
	long := sb.String()
	content := long + "\nshort\n尾行"
	idx, err := Build(strings.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	if idx.LineCount() != 3 {
		t.Fatalf("lines=%d want 3", idx.LineCount())
	}
	if idx.Lines[0].Length != uint32(len(long)+1) {
		t.Fatalf("long line length=%d want %d", idx.Lines[0].Length, len(long)+1)
	}
	res, err := Verify(strings.NewReader(content), idx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Reason != OK {
		t.Fatalf("got %+v", res)
	}
	// Mutate one byte in the middle of the long line.
	mut := []byte(content)
	mut[4<<20] ^= 0x01
	res, err = Verify(bytes.NewReader(mut), idx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Reason != Modified || res.FirstUntrusted != 0 {
		t.Fatalf("got %+v", res)
	}
	full, err := FullScan(bytes.NewReader(mut), idx)
	if err != nil {
		t.Fatal(err)
	}
	if !EqualTrust(res, full) {
		t.Fatalf("incremental %+v disagrees with full scan %+v", res, full)
	}
}

// countingReader records how many bytes were actually consumed.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func TestVerifyStopsEarly(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 20000; i++ {
		sb.WriteString("line 行 ")
		sb.WriteString(strconv.Itoa(i))
		sb.WriteString(" ")
		sb.WriteString(strings.Repeat("数据", 20))
		sb.WriteByte('\n')
	}
	content := []byte(sb.String())
	idx, err := Build(bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	mut := append([]byte(nil), content...)
	mut[idx.Lines[10].Offset] ^= 0xFF // corrupt line 10 of 20000

	cr := &countingReader{r: bytes.NewReader(mut)}
	inc, err := Verify(cr, idx)
	if err != nil {
		t.Fatal(err)
	}
	if inc.Reason != Modified {
		t.Fatalf("got %+v", inc)
	}
	if cr.n > int64(idx.FileSize)/2 {
		t.Fatalf("incremental verify read %d of %d bytes; expected early stop", cr.n, idx.FileSize)
	}
	full, err := FullScan(bytes.NewReader(mut), idx)
	if err != nil {
		t.Fatal(err)
	}
	if !EqualTrust(inc, full) {
		t.Fatalf("incremental %+v disagrees with full scan %+v", inc, full)
	}
}

func TestSidecarDoesNotModifyOriginal(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "app.log")
	content := sampleBytes()
	if err := os.WriteFile(logPath, content, 0o644); err != nil {
		t.Fatal(err)
	}
	before := sha256.Sum256(content)

	idx, err := BuildFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	idxPath := logPath + ".tidx"
	if err := idx.WriteFile(idxPath); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(after) != before {
		t.Fatal("original file changed by indexing")
	}
	if _, err := os.Stat(idxPath); err != nil {
		t.Fatalf("sidecar index missing: %v", err)
	}

	// Round-trip through the on-disk format and verify the untouched file.
	loaded, err := ReadFile(idxPath)
	if err != nil {
		t.Fatal(err)
	}
	res, err := VerifyFile(logPath, loaded)
	if err != nil {
		t.Fatal(err)
	}
	if res.Reason != OK {
		t.Fatalf("got %+v", res)
	}
}

func TestLineAt(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "app.log")
	content := sampleBytes()
	if err := os.WriteFile(logPath, content, 0o644); err != nil {
		t.Fatal(err)
	}
	idx, err := BuildFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for i, want := range sampleLines() {
		got, err := LineAt(f, idx, uint64(i))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("line %d: got %q want %q", i, got, want)
		}
	}
	if _, err := LineAt(f, idx, uint64(len(sampleLines()))); err == nil {
		t.Fatal("expected out-of-range error")
	}
}
