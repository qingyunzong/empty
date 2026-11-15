package dataeng

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWALRotationAndReplay(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "wal")
	w, err := openWALWriter(dir, 1, true) // 1 字节阈值：每条事件都滚动
	if err != nil {
		t.Fatal(err)
	}
	var seen []string
	for i := 0; i < 3; i++ {
		ev := event("r", "t", "q", EvRequest, int64(i), map[string]any{"n": i})
		if err := w.appendEvent(&ev); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.close(); err != nil {
		t.Fatal(err)
	}
	segs, err := walSegments(dir)
	if err != nil || len(segs) != 3 {
		t.Fatalf("segments = %d, err=%v", len(segs), err)
	}
	err = replayWAL(dir, func(ev *Event) error {
		seen = append(seen, ev.RequestID)
		return nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 3 {
		t.Fatalf("replayed events = %d", len(seen))
	}
}

func TestWALCorruptionDetected(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "wal")
	w, _ := openWALWriter(dir, 0, false)
	ev := event("r", "t", "q", EvRequest, 1, nil)
	if err := w.appendEvent(&ev); err != nil {
		t.Fatal(err)
	}
	_ = w.close()

	path := filepath.Join(dir, walSegmentName(1))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// 截断最后 2 字节，制造半帧。
	if err := os.WriteFile(path, data[:len(data)-2], 0o644); err != nil {
		t.Fatal(err)
	}
	err = replayWAL(dir, func(*Event) error { return nil }, nil)
	if err == nil {
		t.Fatal("truncated WAL must be rejected")
	}

	// 翻转一个 payload 字节，制造 CRC 不匹配。
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	data[walHeaderLen] ^= 0xFF
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	err = replayWAL(dir, func(*Event) error { return nil }, nil)
	if err == nil {
		t.Fatal("crc mismatch must be rejected")
	}
}

func TestBlobStoreDigestOnlyRef(t *testing.T) {
	root := t.TempDir()
	store := newBlobStore(root, false)
	ref := BlobRef{
		Algo: "sha256", Digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Size: 12, Role: "response", Run: "r", Target: "t",
		RequestID: "q", EventID: "ev-1",
	}
	if err := store.PutRef(ref); err != nil {
		t.Fatal(err)
	}
	refs, err := store.Refs("sha256", ref.Digest)
	if err != nil || len(refs) != 1 {
		t.Fatalf("refs = %d, err=%v", len(refs), err)
	}
	// 同来源重复登记幂等；不同来源独立保留。
	if err := store.PutRef(ref); err != nil {
		t.Fatal(err)
	}
	other := ref
	other.EventID = "ev-2"
	if err := store.PutRef(other); err != nil {
		t.Fatal(err)
	}
	refs, _ = store.Refs("sha256", ref.Digest)
	if len(refs) != 2 {
		t.Fatalf("refs after second source = %d, want 2", len(refs))
	}
}

func TestSafeSegmentBlocksTraversal(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd": ".._.._etc_passwd",
		"a/b":              "a_b",
		"normal-id_1.2":    "normal-id_1.2",
		"..":               "_",
	}
	for in, want := range cases {
		if got := safeSegment(in); got != want {
			t.Errorf("safeSegment(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUnknownFieldsRoundTrip(t *testing.T) {
	a, _ := testArchive(t)
	_, err := a.Ingest(event("r", "t", "q", EvRequest, 1, map[string]any{
		"method":        "GET",
		"url":           "https://x",
		"x-trace-id":    "abc-123",
		"x-custom-flag": true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	rec, _ := a.GetRecord("r", "t", "q")
	info := rec.Request()
	if info.Extra["x-trace-id"] != "abc-123" {
		t.Fatalf("unknown field lost: %+v", info.Extra)
	}
	if info.Extra["x-custom-flag"] != true {
		t.Fatalf("typed unknown field lost: %+v", info.Extra)
	}
}
