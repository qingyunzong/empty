package trajidx

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "log.txt")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func fileDigest(t *testing.T, path string) [32]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(data)
}

// sameIndex reports whether a and b describe the same file identically.
func sameIndex(a, b *Index) string {
	if a.Size != b.Size {
		return fmt.Sprintf("size %d != %d", a.Size, b.Size)
	}
	if a.LineCount != b.LineCount {
		return fmt.Sprintf("line count %d != %d", a.LineCount, b.LineCount)
	}
	if a.EndsWithNewline != b.EndsWithNewline {
		return "EndsWithNewline differs"
	}
	if a.Digest != b.Digest {
		return "digest differs"
	}
	if len(a.Lines) != len(b.Lines) {
		return fmt.Sprintf("lines %d != %d", len(a.Lines), len(b.Lines))
	}
	for i := range a.Lines {
		if a.Lines[i] != b.Lines[i] {
			return fmt.Sprintf("line %d: %+v != %+v", i, a.Lines[i], b.Lines[i])
		}
	}
	if len(a.Checkpoints) != len(b.Checkpoints) {
		return fmt.Sprintf("checkpoints %d != %d", len(a.Checkpoints), len(b.Checkpoints))
	}
	for i := range a.Checkpoints {
		if a.Checkpoints[i] != b.Checkpoints[i] {
			return fmt.Sprintf("checkpoint %d: %+v != %+v", i, a.Checkpoints[i], b.Checkpoints[i])
		}
	}
	return ""
}

// checkLines verifies every indexed offset by reading the file back.
func checkLines(t *testing.T, path string, idx *Index, want []string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(data)) != idx.Size {
		t.Fatalf("size: file=%d index=%d", len(data), idx.Size)
		if int(idx.LineCount) != len(want) {
			t.Fatalf("line count: got %d want %d", idx.LineCount, len(want))
		}
	}
	for i, w := range want {
		e := idx.Lines[i]
		got := string(data[e.Offset : e.Offset+e.Length])
		if got != w {
			t.Fatalf("line %d: got %q want %q", i, got, w)
		}
	}
}

func TestBuildMultibyteAndNoTrailingNewline(t *testing.T) {
	lines := []string{"你好，世界\n", "héllo wörld ✓\n", "末行没有换行"}
	var buf bytes.Buffer
	for _, l := range lines {
		buf.WriteString(l)
	}
	path := writeFile(t, buf.Bytes())
	before := fileDigest(t, path)

	idx, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	checkLines(t, path, idx, lines)
	if idx.EndsWithNewline {
		t.Fatal("expected EndsWithNewline=false")
	}
	if after := fileDigest(t, path); after != before {
		t.Fatal("Build modified the original file")
	}
	if err := Verify(path, idx); err != nil {
		t.Fatal(err)
	}
}

func TestBuildVeryLongLine(t *testing.T) {
	long := strings.Repeat("长行数据x", 200_000) // ~1.8 MB, multi-byte
	lines := []string{"head\n", long + "\n", "tail\n"}
	path := writeFile(t, []byte(strings.Join(lines, "")))
	idx, err := Build(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	checkLines(t, path, idx, lines)
}

func TestBuildEmpty(t *testing.T) {
	path := writeFile(t, nil)
	idx, err := Build(path, 4)
	if err != nil {
		t.Fatal(err)
	}
	if idx.Size != 0 || idx.LineCount != 0 || len(idx.Lines) != 0 {
		t.Fatalf("unexpected empty index: %+v", idx)
	}
	if err := Verify(path, idx); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateUnchanged(t *testing.T) {
	path := writeFile(t, []byte("a\nb\nc\n"))
	idx, err := Build(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	got, region, err := Update(path, idx)
	if err != nil {
		t.Fatal(err)
	}
	if region != nil {
		t.Fatalf("unexpected region %v", region)
	}
	if d := sameIndex(got, idx); d != "" {
		t.Fatalf("unchanged update altered index: %s", d)
	}
}

func TestUpdateAppendMatchesFullScan(t *testing.T) {
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, fmt.Sprintf("第%d行 log entry\n", i))
	}
	path := writeFile(t, []byte(strings.Join(lines, "")))
	before := fileDigest(t, path)
	old, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	extra := []string{"new 行 10\n", "new 行 11\n", "new 行 12 (no newline)"}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range extra {
		if _, err := f.WriteString(l); err != nil {
			t.Fatal(err)
		}
	}
	f.Close()

	got, region, err := Update(path, old)
	if err != nil {
		t.Fatal(err)
	}
	if region != nil {
		t.Fatalf("append reported untrusted region %v", region)
	}
	full, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if d := sameIndex(got, full); d != "" {
		t.Fatalf("incremental append != full scan: %s", d)
	}
	checkLines(t, path, got, append(lines, extra...))
	if after := fileDigest(t, path); after == before {
		t.Fatal("test setup failed: file should have changed")
	}
}

func TestUpdateAppendAfterNoTrailingNewline(t *testing.T) {
	path := writeFile(t, []byte("a\nb\npartial"))
	old, err := Build(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("-continued\nd\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	got, region, err := Update(path, old)
	if err != nil {
		t.Fatal(err)
	}
	if region != nil {
		t.Fatalf("append reported untrusted region %v", region)
	}
	full, err := Build(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	if d := sameIndex(got, full); d != "" {
		t.Fatalf("incremental append != full scan: %s", d)
	}
	checkLines(t, path, got, []string{"a\n", "b\n", "partial-continued\n", "d\n"})
}

func TestUpdateTruncationLocatesRegion(t *testing.T) {
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, fmt.Sprintf("line-%d\n", i))
	}
	path := writeFile(t, []byte(strings.Join(lines, "")))
	old, err := Build(path, 2) // checkpoints at lines 0,2,4,6,8
	if err != nil {
		t.Fatal(err)
	}
	// Truncate into the middle of line 7.
	cut := old.Lines[7].Offset + 2
	if err := os.Truncate(path, cut); err != nil {
		t.Fatal(err)
	}
	got, region, err := Update(path, old)
	if err != nil {
		t.Fatal(err)
	}
	if region == nil {
		t.Fatal("truncation not detected")
	}
	// Last verifiable checkpoint before the cut is line 6.
	if want := old.Lines[6].Offset; region.Start != want {
		t.Fatalf("region.Start=%d, want %d (start of line 6)", region.Start, want)
	}
	if region.End != cut {
		t.Fatalf("region.End=%d, want %d", region.End, cut)
	}
	full, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if d := sameIndex(got, full); d != "" {
		t.Fatalf("rebuild after truncation != full scan: %s", d)
	}
	if err := Verify(path, got); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateMiddleModificationLocatesRegion(t *testing.T) {
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, fmt.Sprintf("line-%d\n", i))
	}
	path := writeFile(t, []byte(strings.Join(lines, "")))
	old, err := Build(path, 2) // checkpoints at lines 0,2,4,6,8
	if err != nil {
		t.Fatal(err)
	}
	// Overwrite line 5 in place, keeping the same length.
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte("HACK-5\n"), old.Lines[5].Offset); err != nil {
		t.Fatal(err)
	}
	f.Close()

	got, region, err := Update(path, old)
	if err != nil {
		t.Fatal(err)
	}
	if region == nil {
		t.Fatal("modification not detected")
	}
	// First mismatching checkpoint is line 6; last trusted is line 4.
	if want := old.Lines[4].Offset; region.Start != want {
		t.Fatalf("region.Start=%d, want %d (start of line 4)", region.Start, want)
	}
	if want := old.Lines[6].Offset; region.End != want {
		t.Fatalf("region.End=%d, want %d (start of line 6)", region.End, want)
	}
	if region.Start > old.Lines[5].Offset || region.End <= old.Lines[5].Offset {
		t.Fatalf("region %v does not cover modified line 5 at %d", region, old.Lines[5].Offset)
	}
	full, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if d := sameIndex(got, full); d != "" {
		t.Fatalf("rebuild after modification != full scan: %s", d)
	}
}

func TestUpdateEarlyModificationNoTrustedCheckpoint(t *testing.T) {
	path := writeFile(t, []byte("aaaa\nbbbb\ncccc\ndddd\n"))
	old, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte("X"), 1); err != nil { // inside line 0
		t.Fatal(err)
	}
	f.Close()
	got, region, err := Update(path, old)
	if err != nil {
		t.Fatal(err)
	}
	if region == nil || region.Start != 0 {
		t.Fatalf("region=%v, want start 0", region)
	}
	if want := old.Lines[2].Offset; region.End != want {
		t.Fatalf("region.End=%d, want %d (first mismatched checkpoint)", region.End, want)
	}
	full, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if d := sameIndex(got, full); d != "" {
		t.Fatalf("rebuild != full scan: %s", d)
	}
}

func TestVerifyDetectsTamper(t *testing.T) {
	path := writeFile(t, []byte("a\nb\n"))
	idx, err := Build(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("a\nZ\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Verify(path, idx); err == nil {
		t.Fatal("Verify accepted a tampered file")
	}
}

func TestSidecarRoundTrip(t *testing.T) {
	path := writeFile(t, []byte("x\ny\nz"))
	idx, err := Build(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := Save(idx, &buf); err != nil {
		t.Fatal(err)
	}
	back, err := Load(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if d := sameIndex(idx, back); d != "" {
		t.Fatalf("round trip mismatch: %s", d)
	}
	// Sidecar is a separate file; the original is untouched by Save/Load.
	if strings.Contains(path, ".idx") {
		t.Fatal("sidecar path leaked into original path")
	}
}

func TestUpdateModificationAfterLastCheckpoint(t *testing.T) {
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, fmt.Sprintf("line-%d\n", i))
	}
	path := writeFile(t, []byte(strings.Join(lines, "")))
	old, err := Build(path, 2) // last checkpoint at line 8
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte("HACK-9\n"), old.Lines[9].Offset); err != nil {
		t.Fatal(err)
	}
	f.Close()
	got, region, err := Update(path, old)
	if err != nil {
		t.Fatal(err)
	}
	if region == nil {
		t.Fatal("modification after last checkpoint not detected")
	}
	// Every checkpoint still matches; the whole tail after the last
	// checkpoint is the first untrusted region.
	if want := old.Lines[8].Offset; region.Start != want {
		t.Fatalf("region.Start=%d, want %d (last checkpoint)", region.Start, want)
	}
	if region.End != old.Size {
		t.Fatalf("region.End=%d, want %d", region.End, old.Size)
	}
	full, err := Build(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if d := sameIndex(got, full); d != "" {
		t.Fatalf("rebuild != full scan: %s", d)
	}
}
