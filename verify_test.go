package dataeng

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestVerifyAllCachesAcrossGapAndResumes(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	s1 := makeShard(t, 1, "v1", "b")
	s2 := makeShard(t, 2, "v1", "c")
	cache := NewDirCache(t.TempDir())
	first := newFakeDownloader(s0, s2)
	first.setErr(1, errors.New("not yet uploaded"))
	consumer := &Consumer{Downloader: first, Cache: cache, Concurrency: 3, TempDir: t.TempDir()}
	manifest := manifestOf("v1", s0, s1, s2)

	report, err := consumer.VerifyAll(context.Background(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	if report.OK() {
		t.Fatal("report should not be OK")
	}
	if fmt.Sprint(report.Verified) != fmt.Sprint([]int64{0, 2}) {
		t.Fatalf("verified = %v, want [0 2]", report.Verified)
	}
	if fmt.Sprint(report.Missing) != fmt.Sprint([]int64{1}) {
		t.Fatalf("missing = %v, want [1]", report.Missing)
	}
	if got := report.Watermark; got != 1 {
		t.Fatalf("watermark = %d, want 1", got)
	}
	if report.SchemaVersion != "v1" {
		t.Fatalf("schema = %q", report.SchemaVersion)
	}

	repair := newFakeDownloader(s1)
	consumer2 := &Consumer{Downloader: repair, Cache: cache, Concurrency: 3, TempDir: t.TempDir()}
	report2, err := consumer2.VerifyAll(context.Background(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !report2.OK() {
		t.Fatalf("report2 not OK: %+v", report2)
	}
	if fmt.Sprint(report2.Verified) != fmt.Sprint([]int64{0, 1, 2}) {
		t.Fatalf("verified = %v", report2.Verified)
	}
	if got := report2.Watermark; got != 3 {
		t.Fatalf("watermark = %d, want 3", got)
	}
	if repair.Calls(0) != 0 || repair.Calls(1) != 1 || repair.Calls(2) != 0 {
		t.Fatalf("repair download calls = %d/%d/%d, want 0/1/0",
			repair.Calls(0), repair.Calls(1), repair.Calls(2))
	}

	offline := newFakeDownloader()
	for seq := int64(0); seq <= 2; seq++ {
		offline.setErr(seq, errors.New("offline"))
	}
	reader, err := (&Consumer{Downloader: offline, Cache: cache, TempDir: t.TempDir()}).Open(context.Background(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got := readRecords(t, reader)
	want := []string{"0/0/v1/a", "1/0/v1/b", "2/0/v1/c"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("records = %v, want %v", got, want)
	}
	if got := reader.Watermark(); got != 3 {
		t.Fatalf("watermark = %d, want 3", got)
	}
}

func TestVerifyAllReportsManifestGap(t *testing.T) {
	s0 := makeShard(t, 0, "v1", "a")
	s2 := makeShard(t, 2, "v1", "c")
	report, err := (&Consumer{
		Downloader:  newFakeDownloader(s0, s2),
		Concurrency: 2,
		TempDir:     t.TempDir(),
	}).VerifyAll(context.Background(), manifestOf("v1", s0, s2))
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(report.Verified) != fmt.Sprint([]int64{0, 2}) {
		t.Fatalf("verified = %v", report.Verified)
	}
	if fmt.Sprint(report.Missing) != fmt.Sprint([]int64{1}) {
		t.Fatalf("missing = %v", report.Missing)
	}
	if got := report.Watermark; got != 1 {
		t.Fatalf("watermark = %d, want 1", got)
	}
	var missing *MissingShardError
	if !errors.As(report.Errors[1], &missing) || missing.Sequence != 1 {
		t.Fatalf("error for gap = %v", report.Errors[1])
	}
}

func TestVerifyAllInvalidManifest(t *testing.T) {
	m := Manifest{SchemaVersion: "v1", Shards: []Shard{{Sequence: 0, Digest: "bad", LineCount: 1, SchemaVersion: "v1"}}}
	if _, err := (&Consumer{Downloader: newFakeDownloader(), TempDir: t.TempDir()}).VerifyAll(context.Background(), m); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("error = %v, want ErrInvalidManifest", err)
	}
}

func TestVerifyAllEmptyManifest(t *testing.T) {
	report, err := (&Consumer{Downloader: newFakeDownloader(), TempDir: t.TempDir()}).VerifyAll(context.Background(), Manifest{SchemaVersion: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK() || report.Watermark != 0 || report.SchemaVersion != "v1" {
		t.Fatalf("unexpected report: %+v", report)
	}
}
