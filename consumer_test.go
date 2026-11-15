package dataeng

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReaderStreamsInSequenceOrderConcurrently(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a0", "a1")
	s1 := makeShard(t, 1, "v1", "b0")
	s2 := makeShard(t, 2, "v1", "c0", "c1", "c2")
	downloader := newFakeDownloader(s0, s1, s2)
	downloader.setDelay(0, 40*time.Millisecond)
	downloader.setDelay(1, 10*time.Millisecond)
	downloader.setDelay(2, 15*time.Millisecond)

	consumer := &Consumer{Downloader: downloader, Concurrency: 3, Prefetch: 3, TempDir: t.TempDir()}
	reader, err := consumer.Open(context.Background(), Manifest{
		SchemaVersion: "v1",
		Shards:        []Shard{s2.shard, s0.shard, s1.shard},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	records := readRecords(t, reader)
	want := []string{
		"0/0/v1/a0", "0/1/v1/a1",
		"1/0/v1/b0",
		"2/0/v1/c0", "2/1/v1/c1", "2/2/v1/c2",
	}
	if fmt.Sprint(records) != fmt.Sprint(want) {
		t.Fatalf("records = %v, want %v", records, want)
	}
	if got := reader.Watermark(); got != 3 {
		t.Fatalf("watermark = %d, want 3", got)
	}
	if got := downloader.MaxActive(); got < 2 || got > 3 {
		t.Fatalf("max concurrent downloads = %d, want 2..3", got)
	}
}

func TestReaderRejectsDigestMismatch(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	bad := append([]byte(nil), s0.payload...)
	bad[0] ^= 0xff
	downloader := newFakeDownloader(shardPayload{shard: s0.shard, payload: bad})

	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", s0))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err := reader.Next(); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("Next error = %v, want ErrDigestMismatch", err)
	}
	if got := reader.Watermark(); got != 0 {
		t.Fatalf("watermark = %d, want 0", got)
	}
}

func TestReaderRejectsWrongLineCount(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	s0.shard.LineCount = 2
	downloader := newFakeDownloader(s0)

	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", s0))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err := reader.Next(); !errors.Is(err, ErrLineCountMismatch) {
		t.Fatalf("Next error = %v, want ErrLineCountMismatch", err)
	}
}

func TestReaderRejectsSplitLineAtShardBoundary(t *testing.T) {
	firstLines := []string{"a", "partial"}
	firstPayload := encodeLines(t, firstLines, false)
	first := Shard{
		Sequence:      0,
		Digest:        SHA256Digest(firstPayload),
		LineCount:     2,
		SchemaVersion: "v1",
	}
	second := makeShard(t, 1, "v1", "c")
	downloader := newFakeDownloader(
		shardPayload{shard: first, payload: firstPayload},
		second,
	)

	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", shardPayload{shard: first}, second))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err := reader.Next(); !errors.Is(err, ErrSplitLine) {
		t.Fatalf("Next error = %v, want ErrSplitLine", err)
	}
	if got := reader.Watermark(); got != 0 {
		t.Fatalf("watermark = %d, want 0", got)
	}
}

func TestReaderLineLimitAndCRLF(t *testing.T) {
	payload := encodeRaw(t, "a\r\n\nb\r\n")
	s0 := Shard{Sequence: 0, Digest: SHA256Digest(payload), LineCount: 3, SchemaVersion: "v1"}
	downloader := newFakeDownloader(shardPayload{shard: s0, payload: payload})

	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", shardPayload{shard: s0, payload: payload}))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got := readRecords(t, reader)
	want := []string{"0/0/v1/a", "0/1/v1/", "0/2/v1/b"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("records = %v, want %v", got, want)
	}

	longPayload := encodeRaw(t, "abcdef\n")
	long := Shard{Sequence: 0, Digest: SHA256Digest(longPayload), LineCount: 1, SchemaVersion: "v1"}
	longDownloader := newFakeDownloader(shardPayload{shard: long, payload: longPayload})
	longReader, err := (&Consumer{
		Downloader:   longDownloader,
		MaxLineBytes: 4,
		TempDir:      t.TempDir(),
	}).Open(context.Background(), manifestOf("v1", shardPayload{shard: long, payload: longPayload}))
	if err != nil {
		t.Fatal(err)
	}
	defer longReader.Close()
	if _, err := longReader.Next(); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("Next error = %v, want ErrLineTooLong", err)
	}
}

func TestReaderEmptyShard(t *testing.T) {
	empty := makeShard(t, 0, "v1")
	one := makeShard(t, 1, "v1", "x")
	downloader := newFakeDownloader(empty, one)
	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", empty, one))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got := readRecords(t, reader)
	if fmt.Sprint(got) != fmt.Sprint([]string{"1/0/v1/x"}) {
		t.Fatalf("records = %v", got)
	}
	if got := reader.Watermark(); got != 2 {
		t.Fatalf("watermark = %d, want 2", got)
	}
}

func TestReaderMissingShardBlocksWatermark(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a0", "a1")
	s1 := makeShard(t, 1, "v1", "b")
	s2 := makeShard(t, 2, "v1", "c")
	downloader := newFakeDownloader(s0, s2)
	downloader.setErr(1, errors.New("not yet uploaded"))

	reader, err := (&Consumer{
		Downloader:  downloader,
		Concurrency: 3,
		Prefetch:    3,
		TempDir:     t.TempDir(),
	}).Open(context.Background(), manifestOf("v1", s0, s1, s2))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	for i := 0; i < 2; i++ {
		rec, err := reader.Next()
		if err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
		if rec.Sequence != 0 {
			t.Fatalf("record %d sequence = %d, want 0", i, rec.Sequence)
		}
	}
	_, err = reader.Next()
	var missing *MissingShardError
	if !errors.As(err, &missing) {
		t.Fatalf("Next error = %v, want MissingShardError", err)
	}
	if missing.Sequence != 1 {
		t.Fatalf("missing sequence = %d, want 1", missing.Sequence)
	}
	if !errors.Is(err, ErrMissingShard) {
		t.Fatalf("errors.Is ErrMissingShard = false: %v", err)
	}
	if got := reader.Watermark(); got != 1 {
		t.Fatalf("watermark after gap = %d, want 1", got)
	}
}

func TestReaderUsesVerifiedCache(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	s1 := makeShard(t, 1, "v1", "b")
	dir := t.TempDir()
	cache := NewDirCache(dir)
	downloader := newFakeDownloader(s0, s1)
	consumer := &Consumer{Downloader: downloader, Cache: cache, TempDir: t.TempDir()}

	reader, err := consumer.Open(context.Background(), manifestOf("v1", s0, s1))
	if err != nil {
		t.Fatal(err)
	}
	got := readRecords(t, reader)
	if fmt.Sprint(got) != fmt.Sprint([]string{"0/0/v1/a", "1/0/v1/b"}) {
		t.Fatalf("records = %v", got)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if downloader.Calls(0) != 1 || downloader.Calls(1) != 1 {
		t.Fatalf("download calls = %d/%d, want 1/1", downloader.Calls(0), downloader.Calls(1))
	}

	offline := newFakeDownloader()
	offline.setErr(0, errors.New("offline"))
	offline.setErr(1, errors.New("offline"))
	reader2, err := (&Consumer{Downloader: offline, Cache: cache, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", s0, s1))
	if err != nil {
		t.Fatal(err)
	}
	defer reader2.Close()
	got2 := readRecords(t, reader2)
	if fmt.Sprint(got2) != fmt.Sprint(got) {
		t.Fatalf("cache records = %v, want %v", got2, got)
	}
	if offline.Calls(0) != 0 || offline.Calls(1) != 0 {
		t.Fatalf("offline download calls = %d/%d, want 0/0", offline.Calls(0), offline.Calls(1))
	}
}

func TestReaderCorruptCacheFallsBackToDownload(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	s1 := makeShard(t, 1, "v1", "b")
	cache := NewDirCache(t.TempDir())
	first := newFakeDownloader(s0, s1)
	reader, err := (&Consumer{Downloader: first, Cache: cache, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", s0, s1))
	if err != nil {
		t.Fatal(err)
	}
	_ = readRecords(t, reader)
	_ = reader.Close()

	path, err := cache.Path(s0.shard.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("corrupt cache"), 0o644); err != nil {
		t.Fatal(err)
	}

	second := newFakeDownloader(s0, s1)
	var cacheErrors []error
	reader2, err := (&Consumer{
		Downloader: second,
		Cache:      cache,
		TempDir:    t.TempDir(),
		OnCacheError: func(err error) {
			cacheErrors = append(cacheErrors, err)
		},
	}).Open(context.Background(), manifestOf("v1", s0, s1))
	if err != nil {
		t.Fatal(err)
	}
	defer reader2.Close()
	got := readRecords(t, reader2)
	if fmt.Sprint(got) != fmt.Sprint([]string{"0/0/v1/a", "1/0/v1/b"}) {
		t.Fatalf("records = %v", got)
	}
	if second.Calls(0) != 1 || second.Calls(1) != 0 {
		t.Fatalf("download calls = %d/%d, want 1/0", second.Calls(0), second.Calls(1))
	}
	if len(cacheErrors) == 0 {
		t.Fatal("expected a cache error report")
	}

	if info, err := os.Stat(path); err != nil || info.Size() == int64(len("corrupt cache")) {
		t.Fatalf("cache entry was not repaired: info=%v err=%v", info, err)
	}
}

func TestReaderOpenAtResumes(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	s1 := makeShard(t, 1, "v1", "b")
	s2 := makeShard(t, 2, "v1", "c")
	downloader := newFakeDownloader(s0, s1, s2)
	consumer := &Consumer{Downloader: downloader, TempDir: t.TempDir()}
	reader, err := consumer.OpenAt(context.Background(), manifestOf("v1", s0, s1, s2), 2)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got := readRecords(t, reader)
	if fmt.Sprint(got) != fmt.Sprint([]string{"2/0/v1/c"}) {
		t.Fatalf("records = %v", got)
	}
	if got := reader.Watermark(); got != 3 {
		t.Fatalf("watermark = %d, want 3", got)
	}
	if downloader.Calls(0) != 0 || downloader.Calls(1) != 0 || downloader.Calls(2) != 1 {
		t.Fatalf("download calls = %d/%d/%d, want 0/0/1", downloader.Calls(0), downloader.Calls(1), downloader.Calls(2))
	}
}

func TestReaderDuplicateManifestEntrySkipped(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	downloader := newFakeDownloader(s0)
	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), Manifest{
		SchemaVersion: "v1",
		Shards:        []Shard{s0.shard, s0.shard},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got := readRecords(t, reader)
	if fmt.Sprint(got) != fmt.Sprint([]string{"0/0/v1/a"}) {
		t.Fatalf("records = %v", got)
	}
	if downloader.Calls(0) != 1 {
		t.Fatalf("download calls = %d, want 1", downloader.Calls(0))
	}
}

func TestReaderCloseIsIdempotent(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	downloader := newFakeDownloader(s0)
	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", s0))
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Next(); !errors.Is(err, ErrClosed) {
		t.Fatalf("Next after close = %v, want ErrClosed", err)
	}
}

func TestReaderEmptyManifest(t *testing.T) {
	reader, err := (&Consumer{Downloader: newFakeDownloader(), TempDir: t.TempDir()}).Open(
		context.Background(), Manifest{SchemaVersion: "v1"},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if got := reader.SchemaVersion(); got != "v1" {
		t.Fatalf("schema = %q, want v1", got)
	}
	if _, err := reader.Next(); err != io.EOF {
		t.Fatalf("Next = %v, want io.EOF", err)
	}
}

func TestReaderTempFilesAreRemoved(t *testing.T) {
	dir := t.TempDir()
	s0 := makeShard(t, 0, "v1", "a")
	reader, err := (&Consumer{Downloader: newFakeDownloader(s0), TempDir: dir}).Open(context.Background(), manifestOf("v1", s0))
	if err != nil {
		t.Fatal(err)
	}
	_ = readRecords(t, reader)
	_ = reader.Close()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("temp dir contains %d leftovers", len(entries))
	}
}

func TestReaderStartBeforeManifestFails(t *testing.T) {
	s5 := makeShard(t, 5, "v1", "a")
	_, err := (&Consumer{Downloader: newFakeDownloader(s5), TempDir: t.TempDir()}).OpenAt(
		context.Background(), manifestOf("v1", s5), 4,
	)
	if !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("OpenAt error = %v, want ErrInvalidManifest", err)
	}
}

func TestReaderManifestGapReportsMissing(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	s2 := makeShard(t, 2, "v1", "c")
	downloader := newFakeDownloader(s0, s2)
	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", s0, s2))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	rec, err := reader.Next()
	if err != nil || rec.Sequence != 0 {
		t.Fatalf("first record = %+v, err = %v", rec, err)
	}
	_, err = reader.Next()
	var missing *MissingShardError
	if !errors.As(err, &missing) || missing.Sequence != 1 {
		t.Fatalf("Next error = %v, want missing sequence 1", err)
	}
	if got := reader.Watermark(); got != 1 {
		t.Fatalf("watermark = %d, want 1", got)
	}
}

func TestReaderTempDirMustExist(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	missingDir := filepath.Join(t.TempDir(), "does-not-exist")
	reader, err := (&Consumer{Downloader: newFakeDownloader(s0), TempDir: missingDir}).Open(context.Background(), manifestOf("v1", s0))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err := reader.Next(); err == nil {
		t.Fatal("expected an error when TempDir does not exist")
	}
}

func TestDownloaderFunc(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	downloader := DownloaderFunc(func(_ context.Context, shard Shard) (io.ReadCloser, error) {
		if shard.Sequence != 0 {
			return nil, errors.New("unexpected shard")
		}
		return io.NopCloser(bytes.NewReader(s0.payload)), nil
	})
	reader, err := (&Consumer{Downloader: downloader, TempDir: t.TempDir()}).Open(context.Background(), manifestOf("v1", s0))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if got := readRecords(t, reader); fmt.Sprint(got) != fmt.Sprint([]string{"0/0/v1/a"}) {
		t.Fatalf("records = %v", got)
	}
}
