package tail

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"testing"
)

// appendChunk performs one controlled write of raw bytes to a segment,
// opening and closing the file each time so partial head/tail splits are
// visible to the reader exactly as written.
func appendChunk(t *testing.T, dir string, seg int, data []byte) {
	t.Helper()
	f, err := os.OpenFile(SegmentPath(dir, seg), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open segment %d: %v", seg, err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		t.Fatalf("append segment %d: %v", seg, err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close segment %d: %v", seg, err)
	}
}

func encodeRecord(payload []byte) []byte {
	buf := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(buf, uint32(len(payload)))
	copy(buf[4:], payload)
	return buf
}

func mustWait(t *testing.T, r *Reader) {
	t.Helper()
	segBefore, offBefore := r.Position()
	_, err := r.Next()
	if !errors.Is(err, ErrWait) {
		t.Fatalf("Next() err = %v, want ErrWait", err)
	}
	segAfter, offAfter := r.Position()
	// 允许从“尚未附着任何段”(-1,0) 附着到首段开头 (n,0)；
	// 除此之外游标不得移动。
	initialAttach := segBefore == -1 && offBefore == 0 && offAfter == 0
	if !initialAttach && (segAfter != segBefore || offAfter != offBefore) {
		t.Fatalf("cursor moved on ErrWait: (%d,%d) -> (%d,%d)",
			segBefore, offBefore, segAfter, offAfter)
	}
}

func mustRecord(t *testing.T, r *Reader, wantSeg int, wantData string) {
	t.Helper()
	rec, err := r.Next()
	if err != nil {
		t.Fatalf("Next() err = %v, want record %q in segment %d", err, wantData, wantSeg)
	}
	if rec.Segment != wantSeg {
		t.Fatalf("record %q attributed to segment %d, want %d", rec.Data, rec.Segment, wantSeg)
	}
	if string(rec.Data) != wantData {
		t.Fatalf("record data = %q, want %q", rec.Data, wantData)
	}
}

// 尾部未完成：不完整的头/载荷返回 ErrWait 且游标保持，补齐后可读出。
func TestIncompleteTailWaitsAndKeepsCursor(t *testing.T) {
	dir := t.TempDir()
	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	mustWait(t, r) // 空目录，无任何段

	full := encodeRecord([]byte("hello-tail"))
	appendChunk(t, dir, 0, full[:2]) // 头都不完整
	mustWait(t, r)

	appendChunk(t, dir, 0, full[2:4]) // 头补齐，载荷未写
	mustWait(t, r)

	appendChunk(t, dir, 0, full[4:7]) // 载荷部分
	mustWait(t, r)

	appendChunk(t, dir, 0, full[7:]) // 载荷补齐
	mustRecord(t, r, 0, "hello-tail")

	if seg, off := r.Position(); seg != 0 || off != int64(len(full)) {
		t.Fatalf("cursor = (%d,%d), want (0,%d)", seg, off, len(full))
	}
	mustWait(t, r) // 记录读完后回到等待
}

// 中段错误：完整头里的非法长度前缀是确定性失败，而非等待。
func TestCorruptMidStreamFails(t *testing.T) {
	dir := t.TempDir()
	appendChunk(t, dir, 0, encodeRecord([]byte("ok-1")))
	bad := make([]byte, 4)
	binary.BigEndian.PutUint32(bad, DefaultMaxRecordSize+1)
	appendChunk(t, dir, 0, bad)
	appendChunk(t, dir, 0, encodeRecord([]byte("ok-2")))

	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	mustRecord(t, r, 0, "ok-1")

	_, err = r.Next()
	var cerr *CorruptError
	if !errors.As(err, &cerr) {
		t.Fatalf("Next() err = %v, want *CorruptError", err)
	}
	if errors.Is(err, ErrWait) {
		t.Fatalf("corruption must not be reported as ErrWait")
	}
	if cerr.Segment != 0 || cerr.Offset != int64(4+len("ok-1")) {
		t.Fatalf("CorruptError at (%d,%d), want (0,%d)", cerr.Segment, cerr.Offset, 4+len("ok-1"))
	}
}

// 文件轮转：新段出现后，旧句柄必须读完（含轮转后追加的数据）再切新段。
func TestRotationDrainsOldHandleBeforeSwitching(t *testing.T) {
	dir := t.TempDir()
	appendChunk(t, dir, 0, encodeRecord([]byte("a")))
	appendChunk(t, dir, 0, encodeRecord([]byte("b")))

	// 轮转发生：新段已创建并写入。
	appendChunk(t, dir, 1, encodeRecord([]byte("d")))
	// 写者仍在冲刷旧句柄：轮转后旧段又追加了一条。
	appendChunk(t, dir, 0, encodeRecord([]byte("c")))

	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	mustRecord(t, r, 0, "a")
	mustRecord(t, r, 0, "b")
	mustRecord(t, r, 0, "c") // 旧句柄读完才切换
	mustRecord(t, r, 1, "d")
	mustWait(t, r) // 无更新段，回到等待
}

// 分割头尾的可控写入：记录头与载荷分多次落盘，读者逐次等待。
func TestSplitHeadTailWrites(t *testing.T) {
	dir := t.TempDir()
	full := encodeRecord([]byte("split-me"))

	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	appendChunk(t, dir, 0, full[:4]) // 仅头
	mustWait(t, r)
	appendChunk(t, dir, 0, full[4:6]) // 载荷前半
	mustWait(t, r)
	appendChunk(t, dir, 0, full[6:]) // 载荷后半
	mustRecord(t, r, 0, "split-me")
}

// 多段顺序核对：无重复、无丢失，且每条记录所属段正确。
func TestNoDupNoLossAcrossSegments(t *testing.T) {
	dir := t.TempDir()
	const perSeg = 50
	const segs = 3

	want := make([]string, 0, perSeg*segs)
	for s := 0; s < segs; s++ {
		for i := 0; i < perSeg; i++ {
			payload := fmt.Sprintf("seg%d-rec%03d", s, i)
			appendChunk(t, dir, s, encodeRecord([]byte(payload)))
			want = append(want, payload)
		}
	}

	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	got := make([]string, 0, len(want))
	for i := 0; i < len(want); i++ {
		rec, err := r.Next()
		if err != nil {
			t.Fatalf("record %d: Next() err = %v", i, err)
		}
		wantSeg := i / perSeg
		if rec.Segment != wantSeg {
			t.Fatalf("record %d (%q) in segment %d, want %d", i, rec.Data, rec.Segment, wantSeg)
		}
		got = append(got, string(rec.Data))
	}
	mustWait(t, r)

	if len(got) != len(want) {
		t.Fatalf("read %d records, want %d", len(got), len(want))
	}
	seen := make(map[string]int)
	for i, g := range got {
		if g != want[i] {
			t.Fatalf("record %d = %q, want %q (order/loss mismatch)", i, g, want[i])
		}
		seen[g]++
	}
	for p, n := range seen {
		if n != 1 {
			t.Fatalf("record %q read %d times (duplicate)", p, n)
		}
	}
}
