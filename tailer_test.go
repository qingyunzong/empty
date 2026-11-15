package dataeng

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, data string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendFile(t *testing.T, path, data string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(data); err != nil {
		t.Fatal(err)
	}
}

func pollStrings(t *testing.T, tl *Tailer) []Record {
	t.Helper()
	recs, err := tl.Poll()
	if err != nil {
		t.Fatal(err)
	}
	return recs
}

func TestRenameCreate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeFile(t, path, "a\nb\n")

	tl := NewTailer(path)
	defer tl.Close()
	recs := pollStrings(t, tl)
	if len(recs) != 2 || string(recs[0].Data) != "a\n" || string(recs[1].Data) != "b\n" {
		t.Fatalf("unexpected records: %+v", recs)
	}
	if recs[0].Generation != 1 || recs[1].Generation != 1 {
		t.Fatalf("expected generation 1, got %+v", recs)
	}
	if recs[1].Offset != 2 {
		t.Fatalf("expected offset 2, got %d", recs[1].Offset)
	}

	// rename-create：旧文件改名，新文件落到原路径。
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, "c\n")

	recs = pollStrings(t, tl)
	if len(recs) != 1 || string(recs[0].Data) != "c\n" {
		t.Fatalf("unexpected records after rotation: %+v", recs)
	}
	if recs[0].Generation != 2 {
		t.Fatalf("new file must start generation 2, got %d", recs[0].Generation)
	}
	if recs[0].Offset != 0 {
		t.Fatalf("new generation must start at offset 0, got %d", recs[0].Offset)
	}
}

func TestDelayedWriteToOldFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeFile(t, path, "a\n")

	tl := NewTailer(path)
	defer tl.Close()
	pollStrings(t, tl)

	// 模拟仍持有旧 fd 的写入方。
	old, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()

	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, "n1\n")
	// 轮转之后仍写入旧文件。
	if _, err := old.WriteString("a2\n"); err != nil {
		t.Fatal(err)
	}

	recs := pollStrings(t, tl)
	var byGen = map[Generation][]string{}
	for _, r := range recs {
		byGen[r.Generation] = append(byGen[r.Generation], string(r.Data))
	}
	if len(byGen[1]) != 1 || byGen[1][0] != "a2\n" {
		t.Fatalf("delayed write must belong to old generation 1, got %+v", recs)
	}
	if len(byGen[2]) != 1 || byGen[2][0] != "n1\n" {
		t.Fatalf("new file content must belong to generation 2, got %+v", recs)
	}

	// 旧句柄读到 EOF 后已关闭，再次 Poll 不再有旧世代记录。
	recs = pollStrings(t, tl)
	if len(recs) != 0 {
		t.Fatalf("old handle must be closed after EOF, got %+v", recs)
	}
}

func TestCopyTruncate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeFile(t, path, "x\ny\n")

	tl := NewTailer(path)
	defer tl.Close()
	recs := pollStrings(t, tl)
	if len(recs) != 2 {
		t.Fatalf("unexpected records: %+v", recs)
	}
	idBefore := recs[0].FileID

	// copytruncate：同一 inode 原地截断后写入新内容。
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "z\n")

	recs = pollStrings(t, tl)
	if len(recs) != 1 || string(recs[0].Data) != "z\n" {
		t.Fatalf("unexpected records after truncate: %+v", recs)
	}
	if recs[0].FileID != idBefore {
		t.Fatalf("copytruncate keeps the same file id")
	}
	if recs[0].Generation != 2 {
		t.Fatalf("truncation must open generation 2, got %d", recs[0].Generation)
	}
	if recs[0].Offset != 0 {
		t.Fatalf("new generation must start at offset 0, got %d", recs[0].Offset)
	}
}

func TestPartialLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeFile(t, path, "hel")

	tl := NewTailer(path)
	defer tl.Close()
	if recs := pollStrings(t, tl); len(recs) != 0 {
		t.Fatalf("partial line must not be emitted, got %+v", recs)
	}

	appendFile(t, path, "lo\n")
	recs := pollStrings(t, tl)
	if len(recs) != 1 || string(recs[0].Data) != "hello\n" || recs[0].Offset != 0 {
		t.Fatalf("unexpected records: %+v", recs)
	}
}

func TestRestoreSameFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeFile(t, path, "a\nb\n")

	tl := NewTailer(path)
	recs := pollStrings(t, tl)
	if len(recs) != 2 {
		t.Fatalf("unexpected records: %+v", recs)
	}
	cp, ok := tl.Checkpoint()
	if !ok {
		t.Fatal("expected checkpoint")
	}
	tl.Close()

	appendFile(t, path, "c\n")

	rt, err := Restore(cp)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if rt.Generation() != cp.Generation {
		t.Fatalf("restore must keep generation %d, got %d", cp.Generation, rt.Generation())
	}
	recs = pollStrings(t, rt)
	if len(recs) != 1 || string(recs[0].Data) != "c\n" || recs[0].Offset != 4 {
		t.Fatalf("restore must resume from saved offset, got %+v", recs)
	}
}

func TestRestoreRejectsForeignOffset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")

	// 检查点来自旧文件 A。
	writeFile(t, path, "old-1\nold-2\n")
	tl := NewTailer(path)
	pollStrings(t, tl)
	cp, ok := tl.Checkpoint()
	if !ok {
		t.Fatal("expected checkpoint")
	}
	tl.Close()

	// rename-create：路径上已是新文件 B。
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, "new-1\nnew-2\n")

	rt, err := Restore(cp)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	recs := pollStrings(t, rt)
	// 不能把 A 的偏移套到 B：B 必须从头读。
	if len(recs) != 2 || string(recs[0].Data) != "new-1\n" || recs[0].Offset != 0 {
		t.Fatalf("must not apply old file offset to new file, got %+v", recs)
	}
	if recs[0].FileID == cp.FileID {
		t.Fatalf("foreign file must have a different file id")
	}
}

func TestRestoreRejectsNewOffsetOnOldFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")

	// 检查点来自新文件 B（偏移在 B 上推进过）。
	writeFile(t, path, "b1\nb2\nb3\n")
	tl := NewTailer(path)
	pollStrings(t, tl)
	cp, ok := tl.Checkpoint()
	if !ok {
		t.Fatal("expected checkpoint")
	}
	tl.Close()

	// 回滚场景：路径上重新出现旧文件 A（内容、指纹均不同）。
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, "a1\na2\n")

	rt, err := Restore(cp)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	recs := pollStrings(t, rt)
	// 不能把 B 的偏移套到 A：A 必须从头读。
	if len(recs) != 2 || string(recs[0].Data) != "a1\n" || recs[0].Offset != 0 {
		t.Fatalf("must not apply new file offset to old file, got %+v", recs)
	}
}

func TestCheckpointRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeFile(t, path, "a\n")

	tl := NewTailer(path)
	defer tl.Close()
	pollStrings(t, tl)
	cp, ok := tl.Checkpoint()
	if !ok {
		t.Fatal("expected checkpoint")
	}

	cpPath := filepath.Join(dir, "checkpoint.json")
	if err := SaveCheckpoint(cpPath, cp); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadCheckpoint(cpPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != cp {
		t.Fatalf("checkpoint round trip mismatch: %+v != %+v", loaded, cp)
	}
}
