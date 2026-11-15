package dataeng

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"
)

func testCoordinator(t *testing.T, opts ...Option) *Coordinator {
	t.Helper()
	c, err := New(t.TempDir(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func writeTemp(t *testing.T, data []byte) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "browser.part")
	if err := os.WriteFile(filename, data, 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	return filename
}

func TestCompletionBeforeFileIsWritten(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(40*time.Millisecond))
	tempPath := filepath.Join(t.TempDir(), "download.crdownload")
	final := []byte("first half, second half")

	download, err := coord.Track(DownloadSpec{
		ID:             "browser-1",
		SuggestedName:  "report.txt",
		TempPath:       tempPath,
		ExpectedSize:   int64(len(final)),
		ExpectedSHA256: "sha256:" + digest(final),
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}

	// The browser's completion event arrives before the temporary file even
	// exists. Wait must observe it until its length has settled.
	if err := coord.OnComplete(CompletionEvent{ID: "browser-1"}); err != nil {
		t.Fatalf("OnComplete: %v", err)
	}

	writeErr := make(chan error, 1)
	go func() {
		time.Sleep(20 * time.Millisecond)
		file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			writeErr <- err
			return
		}
		defer file.Close()
		if _, err := file.Write(final[:12]); err != nil {
			writeErr <- err
			return
		}
		time.Sleep(30 * time.Millisecond)
		if _, err := file.Write(final[12:]); err != nil {
			writeErr <- err
			return
		}
		writeErr <- nil
	}()

	artifact, err := download.Wait(testContext(t))
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if err := <-writeErr; err != nil {
		t.Fatalf("writer: %v", err)
	}

	if artifact.DownloadID != "browser-1" {
		t.Fatalf("DownloadID = %q", artifact.DownloadID)
	}
	if artifact.Path != filepath.Join(coord.Destination(), "report.txt") {
		t.Fatalf("Path = %q", artifact.Path)
	}
	if artifact.Size != int64(len(final)) {
		t.Fatalf("Size = %d, want %d", artifact.Size, len(final))
	}
	if artifact.SHA256 != digest(final) {
		t.Fatalf("SHA256 = %q, want %q", artifact.SHA256, digest(final))
	}
	if artifact.TempPath != tempPath {
		t.Fatalf("TempPath = %q, want %q", artifact.TempPath, tempPath)
	}
	if artifact.CompletedAt.IsZero() {
		t.Fatal("CompletedAt was not recorded")
	}
	if artifact.PublishedAt.Before(artifact.CompletedAt) {
		t.Fatalf("PublishedAt %v is before CompletedAt %v", artifact.PublishedAt, artifact.CompletedAt)
	}

	got, err := os.ReadFile(artifact.Path)
	if err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if string(got) != string(final) {
		t.Fatalf("artifact contents = %q, want %q", got, final)
	}
	if _, err := os.Stat(tempPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary file still exists: %v", err)
	}

	fromCoordinator, ok := coord.Artifact("browser-1")
	if !ok || fromCoordinator != artifact {
		t.Fatalf("published artifact = %+v, %v", fromCoordinator, ok)
	}
}

func TestCancelDuringSettlementDoesNotAffectAnotherDownload(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(time.Second))
	firstTemp := writeTemp(t, []byte("first"))
	secondTemp := writeTemp(t, []byte("second"))

	first, err := coord.Track(DownloadSpec{ID: "first", SuggestedName: "same.txt", TempPath: firstTemp})
	if err != nil {
		t.Fatalf("Track first: %v", err)
	}
	second, err := coord.Track(DownloadSpec{ID: "second", SuggestedName: "same.txt", TempPath: secondTemp})
	if err != nil {
		t.Fatalf("Track second: %v", err)
	}
	if err := first.MarkComplete(); err != nil {
		t.Fatalf("MarkComplete first: %v", err)
	}
	if err := second.MarkComplete(); err != nil {
		t.Fatalf("MarkComplete second: %v", err)
	}

	firstResult := make(chan error, 1)
	ctx := testContext(t)
	go func() {
		_, err := first.Wait(ctx)
		firstResult <- err
	}()

	time.Sleep(30 * time.Millisecond)
	if err := first.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if err := <-firstResult; !errors.Is(err, ErrCanceled) {
		t.Fatalf("first Wait error = %v, want ErrCanceled", err)
	}
	if _, ok := first.Artifact(); ok {
		t.Fatal("canceled download published an artifact")
	}

	secondArtifact, err := second.Wait(testContext(t))
	if err != nil {
		t.Fatalf("second Wait: %v", err)
	}
	content, err := os.ReadFile(secondArtifact.Path)
	if err != nil {
		t.Fatalf("read second artifact: %v", err)
	}
	if string(content) != "second" {
		t.Fatalf("second content = %q", content)
	}
	if secondArtifact.Path != filepath.Join(coord.Destination(), "same.txt") {
		t.Fatalf("second path = %q", secondArtifact.Path)
	}
}

func TestSameNameDownloadsAreIsolated(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(20*time.Millisecond))
	contents := map[string]string{
		"a": "content-a",
		"b": "content-b",
	}

	downloads := make([]*Download, 0, len(contents))
	for id, content := range contents {
		tempPath := filepath.Join(t.TempDir(), id+".part")
		if err := os.WriteFile(tempPath, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", id, err)
		}
		d, err := coord.Track(DownloadSpec{
			ID:             id,
			SuggestedName:  "same.txt",
			TempPath:       tempPath,
			ExpectedSHA256: digest([]byte(content)),
		})
		if err != nil {
			t.Fatalf("Track %s: %v", id, err)
		}
		if err := d.MarkComplete(); err != nil {
			t.Fatalf("MarkComplete %s: %v", id, err)
		}
		downloads = append(downloads, d)
	}

	type result struct {
		artifact Artifact
		err      error
	}
	results := make(chan result, len(downloads))
	ctx := testContext(t)
	var group sync.WaitGroup
	for _, d := range downloads {
		group.Add(1)
		go func(d *Download) {
			defer group.Done()
			a, err := d.Wait(ctx)
			results <- result{artifact: a, err: err}
		}(d)
	}
	group.Wait()
	close(results)

	var paths []string
	pathContent := make(map[string]string)
	for result := range results {
		if result.err != nil {
			t.Fatalf("Wait: %v", result.err)
		}
		paths = append(paths, filepath.Base(result.artifact.Path))
		content, err := os.ReadFile(result.artifact.Path)
		if err != nil {
			t.Fatalf("read %s: %v", result.artifact.Path, err)
		}
		pathContent[filepath.Base(result.artifact.Path)] = string(content)
	}
	sort.Strings(paths)
	if len(paths) != 2 || paths[0] != "same (1).txt" || paths[1] != "same.txt" {
		t.Fatalf("published names = %v", paths)
	}
	if pathContent["same.txt"] == pathContent["same (1).txt"] {
		t.Fatalf("contents were not isolated: %v", pathContent)
	}
}

func TestDigestMismatchLeavesExistingTargetUntouched(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(10*time.Millisecond))
	target := filepath.Join(coord.Destination(), "report.txt")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatalf("write existing target: %v", err)
	}
	tempPath := writeTemp(t, []byte("new-but-wrong"))

	download, err := coord.Track(DownloadSpec{
		ID:             "bad",
		SuggestedName:  "report.txt",
		TempPath:       tempPath,
		ExpectedSHA256: digest([]byte("expected")),
		Overwrite:      true,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := download.MarkComplete(); err != nil {
		t.Fatalf("MarkComplete: %v", err)
	}

	if _, err := download.Wait(testContext(t)); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("Wait error = %v, want ErrDigestMismatch", err)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(content) != "old" {
		t.Fatalf("existing target was modified: %q", content)
	}
	if _, err := os.Stat(tempPath); err != nil {
		t.Fatalf("temporary file should be retained on failure: %v", err)
	}
	if artifacts := coord.Artifacts(); len(artifacts) != 0 {
		t.Fatalf("published %d artifacts after digest failure", len(artifacts))
	}
}

func TestOverwriteReplacesOnlyAfterVerification(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(10*time.Millisecond))
	target := filepath.Join(coord.Destination(), "report.txt")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatalf("write existing target: %v", err)
	}
	content := []byte("new")
	tempPath := writeTemp(t, content)

	download, err := coord.Track(DownloadSpec{
		ID:             "overwrite",
		SuggestedName:  "report.txt",
		TempPath:       tempPath,
		ExpectedSHA256: digest(content),
		Overwrite:      true,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	artifact, err := coord.Complete(testContext(t), download.ID())
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if artifact.Path != target {
		t.Fatalf("Path = %q, want %q", artifact.Path, target)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("target contents = %q", got)
	}
}

func TestNonOverwriteAllocatesNumberedName(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(10*time.Millisecond))
	target := filepath.Join(coord.Destination(), "report.txt")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatalf("write existing target: %v", err)
	}
	tempPath := writeTemp(t, []byte("new"))

	download, err := coord.Track(DownloadSpec{
		ID:            "unique",
		SuggestedName: "report.txt",
		TempPath:      tempPath,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	artifact, err := coord.Complete(testContext(t), download.ID())
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if artifact.Path != filepath.Join(coord.Destination(), "report (1).txt") {
		t.Fatalf("Path = %q", artifact.Path)
	}
	old, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read old target: %v", err)
	}
	if string(old) != "old" {
		t.Fatalf("existing target changed: %q", old)
	}
	if artifact.SHA256 != digest([]byte("new")) {
		t.Fatalf("SHA256 = %q", artifact.SHA256)
	}
}

func TestWaitDeadlineCanBeRetried(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(0))
	tempPath := filepath.Join(t.TempDir(), "late.part")

	download, err := coord.Track(DownloadSpec{ID: "late", SuggestedName: "late.txt", TempPath: tempPath})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := download.MarkComplete(); err != nil {
		t.Fatalf("MarkComplete: %v", err)
	}

	shortCtx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := download.Wait(shortCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first Wait error = %v, want deadline exceeded", err)
	}

	if err := os.WriteFile(tempPath, []byte("eventually"), 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	artifact, err := download.Wait(testContext(t))
	if err != nil {
		t.Fatalf("second Wait: %v", err)
	}
	content, err := os.ReadFile(artifact.Path)
	if err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if string(content) != "eventually" {
		t.Fatalf("contents = %q", content)
	}
}

func TestCompletionEventRefinesMetadataAndSanitizesName(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(10*time.Millisecond))
	initialTemp := filepath.Join(t.TempDir(), "initial.part")
	eventTemp := filepath.Join(t.TempDir(), "event.part")
	if err := os.WriteFile(eventTemp, []byte("final"), 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}

	download, err := coord.Track(DownloadSpec{
		ID:            "metadata",
		SuggestedName: "../../untrusted.txt",
		TempPath:      initialTemp,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := coord.OnComplete(CompletionEvent{
		ID:             "metadata",
		TempPath:       eventTemp,
		SuggestedName:  `C:\browser\final.txt`,
		ExpectedSHA256: digest([]byte("final")),
	}); err != nil {
		t.Fatalf("OnComplete: %v", err)
	}

	artifact, err := download.Wait(testContext(t))
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if artifact.SuggestedName != "final.txt" {
		t.Fatalf("SuggestedName = %q", artifact.SuggestedName)
	}
	if artifact.Path != filepath.Join(coord.Destination(), "final.txt") {
		t.Fatalf("Path = %q", artifact.Path)
	}
	if filepath.Dir(artifact.Path) != coord.Destination() {
		t.Fatalf("artifact escaped destination: %q", artifact.Path)
	}
}

func TestExpectedSizeMismatchDoesNotPublish(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(10*time.Millisecond))
	tempPath := writeTemp(t, []byte("four"))
	download, err := coord.Track(DownloadSpec{
		ID:            "size",
		SuggestedName: "size.txt",
		TempPath:      tempPath,
		ExpectedSize:  5,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := download.MarkComplete(); err != nil {
		t.Fatalf("MarkComplete: %v", err)
	}
	if _, err := download.Wait(testContext(t)); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("Wait error = %v, want ErrSizeMismatch", err)
	}
	if _, err := os.Stat(filepath.Join(coord.Destination(), "size.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("artifact was published: %v", err)
	}
}

func TestDuplicateUnknownAndInvalidSpecs(t *testing.T) {
	coord := testCoordinator(t)
	tempPath := writeTemp(t, []byte("x"))
	spec := DownloadSpec{ID: "id", SuggestedName: "name.txt", TempPath: tempPath}
	if _, err := coord.Track(spec); err != nil {
		t.Fatalf("Track: %v", err)
	}
	if _, err := coord.Track(spec); !errors.Is(err, ErrDuplicateDownload) {
		t.Fatalf("duplicate Track error = %v", err)
	}
	if _, err := coord.Wait(testContext(t), "missing"); !errors.Is(err, ErrUnknownDownload) {
		t.Fatalf("unknown Wait error = %v", err)
	}
	if err := coord.Cancel("missing"); !errors.Is(err, ErrUnknownDownload) {
		t.Fatalf("unknown Cancel error = %v", err)
	}
	if _, err := coord.Track(DownloadSpec{ID: "bad", SuggestedName: "..", TempPath: tempPath}); !errors.Is(err, ErrInvalidFilename) {
		t.Fatalf("invalid filename error = %v", err)
	}
	if _, err := coord.Track(DownloadSpec{ID: "bad", SuggestedName: "ok", TempPath: tempPath, ExpectedSHA256: "nope"}); !errors.Is(err, ErrInvalidDigest) {
		t.Fatalf("invalid digest error = %v", err)
	}
}

func TestCancelAfterPublicationIsRejected(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(0))
	download, err := coord.Track(DownloadSpec{
		ID:            "done",
		SuggestedName: "done.txt",
		TempPath:      writeTemp(t, []byte("done")),
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if _, err := coord.Complete(testContext(t), download.ID()); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if err := download.Cancel(); !errors.Is(err, ErrAlreadyPublished) {
		t.Fatalf("Cancel error = %v, want ErrAlreadyPublished", err)
	}
}

func TestMultipleWaitersReceiveSameArtifact(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(20*time.Millisecond))
	content := []byte("shared")
	download, err := coord.Track(DownloadSpec{
		ID:            "shared",
		SuggestedName: "shared.txt",
		TempPath:      writeTemp(t, content),
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := download.MarkComplete(); err != nil {
		t.Fatalf("MarkComplete: %v", err)
	}

	ctx := testContext(t)
	const waiters = 8
	results := make(chan Artifact, waiters)
	errs := make(chan error, waiters)
	var group sync.WaitGroup
	for i := 0; i < waiters; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			artifact, err := download.Wait(ctx)
			results <- artifact
			errs <- err
		}()
	}
	group.Wait()
	close(results)
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("Wait: %v", err)
		}
	}
	var expected Artifact
	first := true
	for artifact := range results {
		if first {
			expected = artifact
			first = false
			continue
		}
		if artifact != expected {
			t.Fatalf("waiters received different artifacts: %+v != %+v", artifact, expected)
		}
	}
	if artifacts := coord.Artifacts(); len(artifacts) != 1 {
		t.Fatalf("published %d artifacts, want 1", len(artifacts))
	}
}

func TestRepeatedCompletionEventIsIdempotent(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(10*time.Millisecond))
	tempPath := writeTemp(t, []byte("repeat"))
	download, err := coord.Track(DownloadSpec{
		ID:            "repeat",
		SuggestedName: "repeat.txt",
		TempPath:      tempPath,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := coord.OnComplete(CompletionEvent{ID: "repeat"}); err != nil {
		t.Fatalf("first OnComplete: %v", err)
	}
	if err := coord.OnComplete(CompletionEvent{ID: "repeat", ExpectedSHA256: digest([]byte("repeat"))}); err != nil {
		t.Fatalf("second OnComplete: %v", err)
	}
	if err := download.MarkComplete(); err != nil {
		t.Fatalf("MarkComplete: %v", err)
	}

	artifact, err := download.Wait(testContext(t))
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if artifact.SHA256 != digest([]byte("repeat")) {
		t.Fatalf("SHA256 = %q", artifact.SHA256)
	}
}

func TestCancelBeforeWait(t *testing.T) {
	coord := testCoordinator(t)
	download, err := coord.Track(DownloadSpec{
		ID:            "early-cancel",
		SuggestedName: "never.txt",
		TempPath:      writeTemp(t, []byte("never")),
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := download.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	select {
	case <-download.Done():
	default:
		t.Fatal("Done was not closed by Cancel")
	}
	if _, err := download.Wait(testContext(t)); !errors.Is(err, ErrCanceled) {
		t.Fatalf("Wait error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(coord.Destination(), "never.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled download was published: %v", err)
	}
}

func TestOverwriteDoesNotReplaceDirectory(t *testing.T) {
	coord := testCoordinator(t, WithPollInterval(5*time.Millisecond), WithStableWindow(0))
	target := filepath.Join(coord.Destination(), "occupied")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatalf("mkdir target: %v", err)
	}
	download, err := coord.Track(DownloadSpec{
		ID:            "directory",
		SuggestedName: "occupied",
		TempPath:      writeTemp(t, []byte("data")),
		Overwrite:     true,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if _, err := coord.Complete(testContext(t), download.ID()); !errors.Is(err, ErrTargetIsDirectory) {
		t.Fatalf("Complete error = %v, want ErrTargetIsDirectory", err)
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		t.Fatalf("directory target was changed: %v, %v", info, err)
	}
}
