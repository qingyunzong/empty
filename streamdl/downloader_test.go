package streamdl

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newDownloader(req Requester, staging Staging) *Downloader {
	return &Downloader{Request: req, Staging: staging, ChunkSize: 7}
}

// TestFreshDownload covers the happy path: one plain GET, strong ETag, exact
// length, matching digest and an atomically published destination file.
func TestFreshDownload(t *testing.T) {
	data := bytes.Repeat([]byte("abcdefghij"), 13)
	log := &requestLog{}
	server := staticServer(data, etagV1, log)
	defer server.Close()

	staging := NewMemStaging()
	dst := filepath.Join(t.TempDir(), "out.bin")
	dl := newDownloader(requester(server), staging)

	if err := dl.Download(context.Background(), dst, digestOf(data)); err != nil {
		t.Fatalf("Download: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read published file: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("published content mismatch: got %d bytes, want %d", len(got), len(data))
	}
	reqs := log.snapshot()
	if len(reqs) != 1 || reqs[0].rangeHdr != "" || reqs[0].ifRangeHdr != "" {
		t.Fatalf("expected one plain GET, got %+v", reqs)
	}
	if staged, exists, err := staging.Load(context.Background()); err != nil || exists {
		t.Fatalf("staging must be cleared after publish: exists=%v err=%v staged=%+v", exists, err, staged)
	}
}

// TestEmptyFile verifies that a zero-length entity is checked directly against
// the empty digest without any Range request.
func TestEmptyFile(t *testing.T) {
	log := &requestLog{}
	server := emptyServer(etagV1, log)
	defer server.Close()

	dst := filepath.Join(t.TempDir(), "empty.bin")
	dl := newDownloader(requester(server), NewMemStaging())
	var emptyDigest [32]byte
	if err := dl.Download(context.Background(), dst, emptyDigest); err != nil {
		t.Fatalf("Download empty: %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("published empty file: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("expected zero-length file, got %d", info.Size())
	}
	if reqs := log.snapshot(); len(reqs) != 1 || reqs[0].rangeHdr != "" {
		t.Fatalf("expected exactly one plain GET, got %+v", reqs)
	}

	// A non-empty expected digest must be rejected.
	var bad [32]byte
	bad[0] = 1
	if err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), bad); !errors.Is(err, ErrDigest) {
		t.Fatalf("expected ErrDigest for wrong empty digest, got %v", err)
	}
}

// TestInterruptResume cuts the first connection mid-body, then serves a
// correct 206. The second call must resume at the persisted length with
// If-Range and produce the exact original content.
func TestInterruptResume(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789"), 20)
	log := &requestLog{}
	cutAt := int64(43)
	server := cutServer(data, etagV1, cutAt, log)
	defer server.Close()

	staging := NewMemStaging()
	dst := filepath.Join(t.TempDir(), "resume.bin")
	dl := newDownloader(requester(server), staging)

	err := dl.Download(context.Background(), dst, digestOf(data))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected interruption error, got %v", err)
	}
	staged, exists, err := staging.Load(context.Background())
	if err != nil || !exists {
		t.Fatalf("expected durable staging after interruption: %+v err=%v", staged, err)
	}
	if staged.Length != cutAt || staged.ETag != etagV1 || staged.Total != int64(len(data)) {
		t.Fatalf("unexpected staging state: %+v", staged)
	}

	if err := dl.Download(context.Background(), dst, digestOf(data)); err != nil {
		t.Fatalf("resume Download: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("resumed content mismatch: err=%v", err)
	}
	reqs := log.snapshot()
	if len(reqs) != 2 {
		t.Fatalf("expected two requests, got %d", len(reqs))
	}
	wantRange := "bytes=" + itoa(cutAt) + "-"
	if reqs[1].rangeHdr != wantRange || reqs[1].ifRangeHdr != etagV1 {
		t.Fatalf("resume headers wrong: %+v", reqs[1])
	}
}

// TestEntityRotationResume200 ensures that when the server restarts the
// representation (200 on resume), old staging is discarded and the new entity
// is processed from zero without mixing versions.
func TestEntityRotationResume200(t *testing.T) {
	v1 := bytes.Repeat([]byte("old-version-"), 10)
	v2 := bytes.Repeat([]byte("new-version!"), 12)
	log := &requestLog{}
	server := rotationServer(v1, v2, etagV1, etagV2, true, log)
	defer server.Close()

	staging := NewMemStaging()
	// Seed a v1 savepoint as if a prior download was interrupted.
	txn, err := staging.Begin(context.Background(), 0, etagV1, int64(len(v1)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := txn.Write(v1[:37]); err != nil {
		t.Fatal(err)
	}
	if _, err := txn.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}

	// First call with the rotation server: If-Range mismatches, so it returns
	// a fresh 200 for v2 and the downloader restarts from scratch.
	dst := filepath.Join(t.TempDir(), "rotated.bin")
	dl := newDownloader(requester(server), staging)
	if err := dl.Download(context.Background(), dst, digestOf(v2)); err != nil {
		t.Fatalf("Download after rotation: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, v2) {
		t.Fatalf("published file must be v2 only, got len=%d want=%d", len(got), len(v2))
	}
	if bytes.Contains(got, []byte("old-version")) {
		t.Fatalf("version mixing detected: %q", got[:min(40, len(got))])
	}
	if _, exists, _ := staging.Load(context.Background()); exists {
		t.Fatalf("staging must be cleared after publish")
	}
	reqs := log.snapshot()
	if len(reqs) != 1 || reqs[0].rangeHdr != "bytes=37-" || reqs[0].ifRangeHdr != etagV1 {
		t.Fatalf("expected one resume attempt with v1 headers, got %+v", reqs)
	}
}

// TestSameLengthRotationRejected covers the dangerous case where both versions
// share a length: the digest check must still reject mixed/wrong content.
func TestSameLengthRotationRejected(t *testing.T) {
	v1 := []byte("aaaaaaaaaaaaaaaaaaaa")
	v2 := []byte("bbbbbbbbbbbbbbbbbbbb")
	log := &requestLog{}
	server := rotationServer(v1, v2, etagV1, etagV2, true, log)
	defer server.Close()

	staging := NewMemStaging()
	txn, _ := staging.Begin(context.Background(), 0, etagV1, int64(len(v1)))
	_, _ = txn.Write(v1[:10])
	_, _ = txn.Commit(context.Background())

	dl := newDownloader(requester(server), staging)
	// The server now serves v2 from scratch, but the caller still requires v1.
	dst := filepath.Join(t.TempDir(), "x")
	err := dl.Download(context.Background(), dst, digestOf(v1))
	if !errors.Is(err, ErrDigest) {
		t.Fatalf("expected ErrDigest after same-length rotation, got %v", err)
	}
	if _, exists, _ := staging.Load(context.Background()); exists {
		t.Fatalf("staging must be discarded after digest mismatch")
	}
	if _, err := os.Stat(dst); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("nothing must be published on digest mismatch, stat err=%v", err)
	}
}

// TestBadRangeDiscardsAndRestarts exercises every malformed 206 variant. Each
// must discard staging, surface ErrProtocol and cause the retry to use a plain
// GET from zero.
func TestBadRangeDiscardsAndRestarts(t *testing.T) {
	data := bytes.Repeat([]byte("range-data-"), 8)
	modes := []string{"start", "end", "total", "etag", "body", "header"}
	for _, mode := range modes {
		t.Run(mode, func(t *testing.T) {
			log := &requestLog{}
			server := badRangeServer(data, etagV1, mode, log)
			defer server.Close()

			staging := NewMemStaging()
			txn, _ := staging.Begin(context.Background(), 0, etagV1, int64(len(data)))
			_, _ = txn.Write(data[:25])
			_, _ = txn.Commit(context.Background())

			dl := newDownloader(requester(server), staging)
			err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data))
			if !errors.Is(err, ErrProtocol) {
				t.Fatalf("mode %s: expected ErrProtocol, got %v", mode, err)
			}
			if _, exists, _ := staging.Load(context.Background()); exists {
				t.Fatalf("mode %s: staging must be discarded", mode)
			}

			// Next call against a correct static server must start at zero.
			goodLog := &requestLog{}
			good := staticServer(data, etagV1, goodLog)
			defer good.Close()
			dl.Request = requester(good)
			dst := filepath.Join(t.TempDir(), "recovered.bin")
			if err := dl.Download(context.Background(), dst, digestOf(data)); err != nil {
				t.Fatalf("mode %s: fresh retry: %v", mode, err)
			}
			reqs := goodLog.snapshot()
			if len(reqs) != 1 || reqs[0].rangeHdr != "" {
				t.Fatalf("mode %s: retry must be a plain GET from zero, got %+v", mode, reqs)
			}
			got, _ := os.ReadFile(dst)
			if !bytes.Equal(got, data) {
				t.Fatalf("mode %s: recovered content mismatch", mode)
			}
		})
	}
}

// TestCancellationPersistsPrefix cancels an in-flight download and confirms
// the prefix is durable and resumable.
func TestCancellationPersistsPrefix(t *testing.T) {
	data := bytes.Repeat([]byte("cancel-me!!"), 25)
	log := &requestLog{}
	prefix := 21
	server := stallServer(data, etagV1, prefix, log)
	defer server.Close()

	staging := NewMemStaging()
	dl := newDownloader(requester(server), staging)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	err := dl.Download(ctx, filepath.Join(t.TempDir(), "x"), digestOf(data))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
	staged, exists, err := staging.Load(context.Background())
	if err != nil || !exists {
		t.Fatalf("expected durable savepoint after cancellation: %+v %v %v", staged, exists, err)
	}
	if staged.Length != int64(prefix) || staged.ETag != etagV1 || staged.Total != int64(len(data)) {
		t.Fatalf("unexpected savepoint: %+v", staged)
	}

	// Resume against a correct server and confirm the full content matches.
	goodLog := &requestLog{}
	good := staticServer(data, etagV1, goodLog)
	defer good.Close()
	dl.Request = requester(good)
	dst := filepath.Join(t.TempDir(), "cancel-resume.bin")
	if err := dl.Download(context.Background(), dst, digestOf(data)); err != nil {
		t.Fatalf("resume after cancel: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, data) {
		t.Fatalf("content after cancel-resume mismatch")
	}
	reqs := goodLog.snapshot()
	if len(reqs) != 1 || reqs[0].rangeHdr != "bytes="+itoa(int64(prefix))+"-" || reqs[0].ifRangeHdr != etagV1 {
		t.Fatalf("resume after cancel must use Range/If-Range, got %+v", reqs)
	}
}

// TestUnexpectedStatusKeepsStaging verifies that transport-level failures and
// unexpected statuses do not destroy a usable savepoint.
func TestUnexpectedStatusKeepsStaging(t *testing.T) {
	data := bytes.Repeat([]byte("keep"), 9)
	log := &requestLog{}
	server := statusServer(http.StatusInternalServerError, log)
	defer server.Close()

	staging := NewMemStaging()
	txn, _ := staging.Begin(context.Background(), 0, etagV1, int64(len(data)))
	_, _ = txn.Write(data[:12])
	_, _ = txn.Commit(context.Background())

	dl := newDownloader(requester(server), staging)
	err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol, got %v", err)
	}
	staged, exists, err := staging.Load(context.Background())
	if err != nil || !exists || staged.Length != 12 {
		t.Fatalf("savepoint must survive unexpected status: %+v exists=%v err=%v", staged, exists, err)
	}
}

// TestInitialResponseValidation checks the first-contact requirements:
// status must be 200 with a strong ETag and known length.
func TestInitialResponseValidation(t *testing.T) {
	data := []byte("validation-data")
	t.Run("missing etag", func(t *testing.T) {
		log := &requestLog{}
		server := missingEtagServer(data, log)
		defer server.Close()
		dl := newDownloader(requester(server), NewMemStaging())
		if err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data)); !errors.Is(err, ErrProtocol) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("weak etag", func(t *testing.T) {
		log := &requestLog{}
		server := weakEtagServer(data, etagV1, log)
		defer server.Close()
		dl := newDownloader(requester(server), NewMemStaging())
		if err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data)); !errors.Is(err, ErrProtocol) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("500 status", func(t *testing.T) {
		log := &requestLog{}
		server := statusServer(http.StatusInternalServerError, log)
		defer server.Close()
		dl := newDownloader(requester(server), NewMemStaging())
		if err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data)); !errors.Is(err, ErrProtocol) {
			t.Fatalf("got %v", err)
		}
	})
}
