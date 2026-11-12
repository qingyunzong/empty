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
)

// Test206WithoutResumeRejected ensures a partial response to a plain GET is a
// protocol violation and does not get streamed into staging.
func Test206WithoutResumeRejected(t *testing.T) {
	data := []byte("no-resume-206-body")
	log := &requestLog{}
	server := start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("ETag", etagV1)
		w.Header().Set("Content-Range", "bytes 0-"+itoa(int64(len(data))-1)+"/"+itoa(int64(len(data))))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data)
	}))
	defer server.Close()

	staging := NewMemStaging()
	dl := newDownloader(requester(server), staging)
	err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol for 206 on a plain GET, got %v", err)
	}
	if _, exists, _ := staging.Load(context.Background()); exists {
		t.Fatalf("nothing must be staged after a rejected 206")
	}
	if reqs := log.snapshot(); len(reqs) != 1 || reqs[0].rangeHdr != "" {
		t.Fatalf("request must be a plain GET: %+v", reqs)
	}
}

// TestShortBodyInterrupted verifies that a body ending before the declared
// Content-Length is treated as an interruption: the verified prefix stays
// staged and a later correct call resumes and completes.
func TestShortBodyInterrupted(t *testing.T) {
	data := []byte("exact-length-body!!12345")
	log := &requestLog{}
	cutAt := int64(19)
	server := cutServer(data, etagV1, cutAt, log)
	defer server.Close()

	staging := NewMemStaging()
	dl := newDownloader(requester(server), staging)
	err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected interruption for short body, got %v", err)
	}
	staged, exists, err := staging.Load(context.Background())
	if err != nil || !exists || staged.Length != cutAt {
		t.Fatalf("expected %d-byte savepoint: %+v %v %v", cutAt, staged, exists, err)
	}

	goodLog := &requestLog{}
	good := staticServer(data, etagV1, goodLog)
	defer good.Close()
	dl.Request = requester(good)
	dst := filepath.Join(t.TempDir(), "recovered.bin")
	if err := dl.Download(context.Background(), dst, digestOf(data)); err != nil {
		t.Fatalf("resume after short body: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, data) {
		t.Fatalf("recovered content mismatch")
	}
}

// TestOversizedBodyRejected verifies the defensive overrun guard. It is driven
// through a raw Staging transaction because net/http caps reads at
// Content-Length, so an overrun cannot arrive via a normal client body.
func TestOversizedBodyRejected(t *testing.T) {
	data := []byte("exact-length-body!!")
	log := &requestLog{}
	server := start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("ETag", etagV1)
		w.Header().Set("Content-Length", itoa(int64(len(data))))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
	defer server.Close()

	staging := NewMemStaging()
	dl := newDownloader(requester(server), staging)

	// Feed a body that emits one extra byte beyond the declared total.
	total := int64(len(data))
	overflow := io.MultiReader(
		bytes.NewReader(data),
		bytes.NewReader([]byte{0xEE}),
	)
	err := dl.stream(context.Background(), overflow, 0, total, etagV1, digestOf(data),
		filepath.Join(t.TempDir(), "x"))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol from overrun guard, got %v", err)
	}
	if _, exists, _ := staging.Load(context.Background()); exists {
		t.Fatalf("staging must be discarded on overrun")
	}
}

// TestResumeContentLengthMismatch verifies a 206 whose Content-Length header
// disagrees with the range span is rejected and staging is dropped.
func TestResumeContentLengthMismatch(t *testing.T) {
	data := []byte("0123456789abcdefghij")
	log := &requestLog{}
	server := start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		start, _ := parseSuffixRange(r.Header.Get("Range"))
		w.Header().Set("ETag", etagV1)
		w.Header().Set("Content-Range",
			"bytes "+itoa(start)+"-"+itoa(int64(len(data))-1)+"/"+itoa(int64(len(data))))
		// Deliberately wrong Content-Length for the actual span.
		w.Header().Set("Content-Length", "3")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[start:])
	}))
	defer server.Close()

	staging := NewMemStaging()
	txn, _ := staging.Begin(context.Background(), 0, etagV1, int64(len(data)))
	_, _ = txn.Write(data[:8])
	_, _ = txn.Commit(context.Background())

	dl := newDownloader(requester(server), staging)
	err := dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol for Content-Length mismatch, got %v", err)
	}
	if _, exists, _ := staging.Load(context.Background()); exists {
		t.Fatalf("staging must be discarded on range mismatch")
	}
}
