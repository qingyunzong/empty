package q150

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// roundTripFunc 是无需监听端口的 http.RoundTripper，用于测试默认拨号器。
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func newHTTPResponse(body, contentType string, status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{contentType}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// TestDefaultDialerHeadersAndBody 验证默认拨号器设置 SSE 头、透传
// Last-Event-ID，并能读取真实响应正文。
func TestDefaultDialerHeadersAndBody(t *testing.T) {
	var lastEventID, accept atomic.Value
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			lastEventID.Store(req.Header.Get("Last-Event-ID"))
			accept.Store(req.Header.Get("Accept"))
			return newHTTPResponse("id: h1\ndata: hello\n\n", "text/event-stream", http.StatusOK), nil
		}),
	}

	store := &failingStore{id: "seed", ok: true}
	sub, err := NewSubscriber(Config{
		URL:          "https://example.invalid/events",
		HTTPClient:   client,
		Store:        store,
		DefaultRetry: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewSubscriber: %v", err)
	}
	runDone := runInGoroutine(sub)

	ev, err := sub.Next(context.Background())
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if ev.Data != "hello" || ev.LastEventID != "h1" {
		t.Fatalf("event mismatch: %+v", ev)
	}
	gotID, _ := lastEventID.Load().(string)
	gotAccept, _ := accept.Load().(string)
	if gotID != "seed" {
		t.Fatalf("Last-Event-ID = %q, want seed", gotID)
	}
	if gotAccept != "text/event-stream" {
		t.Fatalf("Accept = %q, want text/event-stream", gotAccept)
	}

	if err := sub.Ack(context.Background()); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if id, _ := store.snapshot(); id != "h1" {
		t.Fatalf("store id = %q, want h1", id)
	}

	sub.Close()
	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// TestDefaultDialerNoIDHeader 验证没有恢复 ID 时不发送 Last-Event-ID。
func TestDefaultDialerNoIDHeader(t *testing.T) {
	var sawID atomic.Bool
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			_, ok := req.Header["Last-Event-Id"]
			sawID.Store(ok)
			return newHTTPResponse("data: x\n\n", "text/event-stream", http.StatusOK), nil
		}),
	}
	sub, err := NewSubscriber(Config{
		URL:        "https://example.invalid/events",
		HTTPClient: client,
		Store:      NewMemoryStore(),
	})
	if err != nil {
		t.Fatal(err)
	}
	runDone := runInGoroutine(sub)
	if _, err := sub.Next(context.Background()); err != nil {
		t.Fatalf("Next: %v", err)
	}
	if sawID.Load() {
		t.Fatal("Last-Event-ID must be absent when no resume id")
	}
	sub.Close()
	<-runDone
}

// TestDefaultDialerRejectsBadStatus 验证非 200 状态被拒绝并重试。
func TestDefaultDialerRejectsBadStatus(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return newHTTPResponse("boom", "text/event-stream", http.StatusInternalServerError), nil
		}),
	}
	var attempts atomic.Int32
	sub, err := NewSubscriber(Config{
		URL:          "https://example.invalid/events",
		HTTPClient:   client,
		Store:        NewMemoryStore(),
		DefaultRetry: 5 * time.Millisecond,
		onWait:       func(time.Duration) { attempts.Add(1) },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		waitUntil(t, func() bool { return attempts.Load() >= 2 }, 2*time.Second, "no retry")
		cancel()
	}()
	if err := sub.Run(ctx); err != context.Canceled {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}
}

// TestDefaultDialerRejectsBadContentType 验证错误 Content-Type 被拒绝并重试。
func TestDefaultDialerRejectsBadContentType(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return newHTTPResponse("nope", "text/plain; charset=utf-8", http.StatusOK), nil
		}),
	}
	sub, err := NewSubscriber(Config{
		URL:          "https://example.invalid/events",
		HTTPClient:   client,
		Store:        NewMemoryStore(),
		DefaultRetry: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := sub.Run(ctx); err != context.DeadlineExceeded {
		t.Fatalf("Run err = %v, want DeadlineExceeded (kept retrying)", err)
	}
}
