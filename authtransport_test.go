package dataeng

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type atomicInt struct {
	value atomic.Int64
}

const attemptIDHeader = "X-Test-Attempt-Id"

var nextAttemptID atomic.Uint64

func (a *atomicInt) add(delta int64) int64 {
	return a.value.Add(delta)
}

func (a *atomicInt) addAndGet(delta int64) int64 {
	return a.value.Add(delta)
}

func (a *atomicInt) get() int {
	return int(a.value.Load())
}

type recordedRequest struct {
	seq    int
	method string
	auth   string
	body   string
}

type trackedBody struct {
	io.ReadCloser
	mu     sync.Mutex
	closed bool
}

func (b *trackedBody) Close() error {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	return b.ReadCloser.Close()
}

func (b *trackedBody) isClosed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closed
}

type controllableTransport struct {
	mu       sync.Mutex
	seq      int
	requests []recordedRequest
	attempts map[string]int
	handler  func(req *http.Request, seq int) (*http.Response, error)
}

func (c *controllableTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	bodyText := ""
	if req.Body != nil {
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		_ = req.Body.Close()
		bodyText = string(raw)
	}

	c.mu.Lock()
	c.seq++
	seq := c.seq
	if c.attempts == nil {
		c.attempts = make(map[string]int)
	}
	id := req.Header.Get(attemptIDHeader)
	c.attempts[id]++
	attempt := c.attempts[id]
	c.requests = append(c.requests, recordedRequest{
		seq:    seq,
		method: req.Method,
		auth:   req.Header.Get("Authorization"),
		body:   bodyText,
	})
	c.mu.Unlock()

	return c.handler(req, attempt)
}

func (c *controllableTransport) snapshot() []recordedRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]recordedRequest, len(c.requests))
	copy(out, c.requests)
	return out
}

func (c *controllableTransport) callCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.seq
}

type roundTripResult struct {
	resp *http.Response
	err  error
}

func mockResponse(status int) (*http.Response, *trackedBody) {
	body := &trackedBody{ReadCloser: io.NopCloser(strings.NewReader("response-body"))}
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       body,
	}, body
}

func mustRequest(t *testing.T, method string, body io.Reader) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, "http://collector.example/ingest", body)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set(attemptIDHeader, newAttemptID())
	return req
}

func newAttemptID() string {
	return strconv.FormatUint(nextAttemptID.Add(1), 10)
}

func waitGroupWithTimeout(t *testing.T, wg *sync.WaitGroup, timeout time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatalf("timed out after %s", timeout)
	}
}

func chooseStatus(firstAttempt bool) int {
	if firstAttempt {
		return http.StatusUnauthorized
	}
	return http.StatusOK
}

func TestConcurrent401SingleRefresh(t *testing.T) {
	var refreshCalls atomicInt
	started := make(chan struct{})
	proceed := make(chan struct{})
	firstAttemptDone := make(chan struct{}, 5)

	base := &controllableTransport{
		handler: func(_ *http.Request, attempt int) (*http.Response, error) {
			if attempt == 1 {
				firstAttemptDone <- struct{}{}
			}
			resp, _ := mockResponse(chooseStatus(attempt == 1))
			return resp, nil
		},
	}
	var startOnce sync.Once
	refresh := func(_ context.Context) (Token, error) {
		refreshCalls.add(1)
		startOnce.Do(func() { close(started) })
		<-proceed
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	const clients = 5
	var wg sync.WaitGroup
	errs := make([]error, clients)
	resps := make([]*http.Response, clients)
	wg.Add(clients)
	for i := 0; i < clients; i++ {
		go func(idx int) {
			defer wg.Done()
			resps[idx], errs[idx] = at.RoundTrip(mustRequest(t, http.MethodGet, nil))
		}(i)
	}
	for i := 0; i < clients; i++ {
		select {
		case <-firstAttemptDone:
		case <-time.After(time.Second):
			t.Fatalf("only %d of %d first attempts reached the transport", i, clients)
		}
	}

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("refresh never started")
	}
	if got := refreshCalls.get(); got != 1 {
		t.Fatalf("refresh started %d times, want 1", got)
	}

	close(proceed)
	waitGroupWithTimeout(t, &wg, 2*time.Second)

	for i, err := range errs {
		if err != nil {
			t.Fatalf("client %d: %v", i, err)
		}
	}
	for i, resp := range resps {
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("client %d status = %d, want 200", i, resp.StatusCode)
		}
		_ = resp.Body.Close()
	}

	if got := base.callCount(); got != 2*clients {
		t.Fatalf("base calls = %d, want %d", got, 2*clients)
	}
	if got := refreshCalls.get(); got != 1 {
		t.Fatalf("refresh calls = %d, want 1", got)
	}
	seen := base.snapshot()
	for i := 0; i < clients; i++ {
		if seen[i].auth != "Bearer token-v1" {
			t.Fatalf("request %d auth = %q, want v1 token", i, seen[i].auth)
		}
		if seen[clients+i].auth != "Bearer token-v2" {
			t.Fatalf("retry %d auth = %q, want v2 token", i, seen[clients+i].auth)
		}
	}
}

func TestRefreshFailureRecovery(t *testing.T) {
	var refreshCalls atomicInt
	failedBodies := make([]*trackedBody, 0, 1)
	base := &controllableTransport{
		handler: func(_ *http.Request, attempt int) (*http.Response, error) {
			status := chooseStatus(attempt == 1)
			resp, body := mockResponse(status)
			if status == http.StatusUnauthorized {
				failedBodies = append(failedBodies, body)
			}
			return resp, nil
		},
	}

	boom := errors.New("refresh backend unavailable")
	refresh := func(_ context.Context) (Token, error) {
		n := refreshCalls.addAndGet(1)
		if n == 1 {
			return Token{}, boom
		}
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	first, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
	if !errors.Is(err, boom) {
		t.Fatalf("first round trip err = %v, want %v", err, boom)
	}
	if first != nil {
		t.Fatal("first round trip returned a response alongside the refresh error")
	}
	if len(failedBodies) != 1 || !failedBodies[0].isClosed() {
		t.Fatal("401 body must be closed before returning the refresh error")
	}

	second, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
	if err != nil {
		t.Fatalf("second round trip: %v", err)
	}
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second status = %d, want 200", second.StatusCode)
	}
	_ = second.Body.Close()

	if got := refreshCalls.get(); got != 2 {
		t.Fatalf("refresh calls = %d, want 2 (failure must not be cached)", got)
	}
}

func TestNonReplayableRequestReturnsRaw401(t *testing.T) {
	var refreshCalls atomicInt
	base := &controllableTransport{
		handler: func(_ *http.Request, _ int) (*http.Response, error) {
			resp, _ := mockResponse(http.StatusUnauthorized)
			return resp, nil
		},
	}
	refresh := func(_ context.Context) (Token, error) {
		refreshCalls.add(1)
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	req := mustRequest(t, http.MethodPost, nil)
	req.Body = io.NopCloser(strings.NewReader("payload"))

	resp, err := at.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want original 401", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read 401 body: %v", err)
	}
	if string(raw) != "response-body" {
		t.Fatalf("401 body = %q, want original body", string(raw))
	}
	_ = resp.Body.Close()

	if got := base.callCount(); got != 1 {
		t.Fatalf("base calls = %d, want 1 (no retry)", got)
	}
	if got := refreshCalls.get(); got != 0 {
		t.Fatalf("refresh calls = %d, want 0", got)
	}
}

func TestWaiterCancellationDoesNotCancelRefresh(t *testing.T) {
	proceed := make(chan struct{})
	refreshEntered := make(chan struct{})
	var refreshCalls atomicInt
	var refreshCtx context.Context
	var enterOnce sync.Once
	secondAttempts := make(chan struct{}, 1)
	var seenFirstRequest atomic.Bool

	base := &controllableTransport{
		handler: func(_ *http.Request, attempt int) (*http.Response, error) {
			status := chooseStatus(attempt == 1)
			resp, _ := mockResponse(status)
			if attempt == 1 {
				if seenFirstRequest.Swap(true) {
					secondAttempts <- struct{}{}
				}
			}
			return resp, nil
		},
	}
	refresh := func(ctx context.Context) (Token, error) {
		refreshCalls.add(1)
		refreshCtx = ctx
		enterOnce.Do(func() { close(refreshEntered) })
		<-proceed
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	ctx1, cancel1 := context.WithCancel(context.Background())
	req1 := mustRequest(t, http.MethodGet, nil).Clone(ctx1)
	result1 := make(chan roundTripResult, 1)
	go func() {
		resp, err := at.RoundTrip(req1)
		result1 <- roundTripResult{resp, err}
	}()

	select {
	case <-refreshEntered:
	case <-time.After(time.Second):
		t.Fatal("refresh never entered blocking phase")
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	req2 := mustRequest(t, http.MethodGet, nil).Clone(ctx2)
	result2 := make(chan roundTripResult, 1)
	go func() {
		resp, err := at.RoundTrip(req2)
		result2 <- roundTripResult{resp, err}
	}()
	select {
	case <-secondAttempts:
	case <-time.After(time.Second):
		t.Fatal("second request never reached the transport and joined the wait")
	}

	cancel1()
	select {
	case res := <-result1:
		if !errors.Is(res.err, context.Canceled) {
			t.Fatalf("canceled waiter err = %v, want context.Canceled", res.err)
		}
		if res.resp != nil {
			t.Fatal("canceled waiter must not receive a response")
		}
	case <-time.After(time.Second):
		t.Fatal("canceled waiter did not return")
	}

	if refreshCtx.Err() != nil {
		t.Fatalf("refresh context ended early: %v", refreshCtx.Err())
	}

	close(proceed)
	select {
	case res := <-result2:
		if res.err != nil {
			t.Fatalf("waiting request: %v", res.err)
		}
		if res.resp.StatusCode != http.StatusOK {
			t.Fatalf("waiting request status = %d, want 200", res.resp.StatusCode)
		}
		_ = res.resp.Body.Close()
	case <-time.After(time.Second):
		t.Fatal("waiting request did not complete after refresh")
	}

	if got := refreshCalls.get(); got != 1 {
		t.Fatalf("refresh calls = %d, want 1", got)
	}
	if got := base.callCount(); got != 3 {
		t.Fatalf("base calls = %d, want 3", got)
	}
}

func TestCloseCancelsRefreshAndRejectsNewRequests(t *testing.T) {
	started := make(chan struct{})
	var refreshCtx context.Context
	var startOnce sync.Once

	base := &controllableTransport{
		handler: func(_ *http.Request, _ int) (*http.Response, error) {
			resp, _ := mockResponse(http.StatusUnauthorized)
			return resp, nil
		},
	}
	refresh := func(ctx context.Context) (Token, error) {
		refreshCtx = ctx
		startOnce.Do(func() { close(started) })
		<-ctx.Done()
		return Token{}, ctx.Err()
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	result := make(chan roundTripResult, 1)
	go func() {
		resp, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
		result <- roundTripResult{resp, err}
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("refresh never started")
	}

	if err := at.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := at.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}

	select {
	case res := <-result:
		if !errors.Is(res.err, context.Canceled) {
			t.Fatalf("in-flight err = %v, want context.Canceled", res.err)
		}
	case <-time.After(time.Second):
		t.Fatal("in-flight request did not return after close")
	}

	resp, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
	if !errors.Is(err, ErrTransportClosed) {
		t.Fatalf("new request err = %v, want %v", err, ErrTransportClosed)
	}
	if resp != nil {
		t.Fatal("new request after close must not return a response")
	}
	if refreshCtx.Err() == nil {
		t.Fatal("refresh context was not canceled by Close")
	}
}

func TestStale401UsesCurrentTokenWithoutRefresh(t *testing.T) {
	var refreshCalls atomicInt
	firstAttempt := make(chan struct{})
	rotated := make(chan struct{})

	base := &controllableTransport{
		handler: func(_ *http.Request, seq int) (*http.Response, error) {
			if seq == 1 {
				close(firstAttempt)
				<-rotated
			}
			resp, _ := mockResponse(chooseStatus(seq == 1))
			return resp, nil
		},
	}
	refresh := func(_ context.Context) (Token, error) {
		refreshCalls.add(1)
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	result := make(chan roundTripResult, 1)
	go func() {
		resp, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
		result <- roundTripResult{resp, err}
	}()

	select {
	case <-firstAttempt:
	case <-time.After(time.Second):
		t.Fatal("first request never reached the transport")
	}
	if err := at.UpdateToken(Token{Value: "token-v3", Version: 3}); err != nil {
		t.Fatalf("update token: %v", err)
	}
	close(rotated)

	select {
	case res := <-result:
		if res.err != nil {
			t.Fatalf("round trip: %v", res.err)
		}
		if res.resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", res.resp.StatusCode)
		}
		_ = res.resp.Body.Close()
	case <-time.After(time.Second):
		t.Fatal("round trip did not complete")
	}

	if got := refreshCalls.get(); got != 0 {
		t.Fatalf("refresh calls = %d, want 0 (stale 401 must not refresh)", got)
	}
	seen := base.snapshot()
	if seen[0].auth != "Bearer token-v1" || seen[1].auth != "Bearer token-v3" {
		t.Fatalf("auth sequence = [%s, %s], want [v1, v3]", seen[0].auth, seen[1].auth)
	}
}

func TestSecond401ReturnedRawAndBodyClosedBeforeRetry(t *testing.T) {
	var firstBody *trackedBody
	base := &controllableTransport{
		handler: func(_ *http.Request, attempt int) (*http.Response, error) {
			resp, body := mockResponse(http.StatusUnauthorized)
			if attempt == 1 {
				firstBody = body
			}
			return resp, nil
		},
	}
	refresh := func(_ context.Context) (Token, error) {
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	resp, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want second 401 passed through", resp.StatusCode)
	}
	if resp.Body == nil {
		t.Fatal("retry response body must be handed to the caller")
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read retry body: %v", err)
	}
	if string(raw) != "response-body" {
		t.Fatalf("retry body = %q, want raw retry body", string(raw))
	}
	_ = resp.Body.Close()

	if got := base.callCount(); got != 2 {
		t.Fatalf("base calls = %d, want 2 (single retry)", got)
	}
	if firstBody == nil || !firstBody.isClosed() {
		t.Fatal("original 401 body must be closed before the retry")
	}
}

func TestPostWithGetBodyIsReplayedOnce(t *testing.T) {
	base := &controllableTransport{
		handler: func(_ *http.Request, attempt int) (*http.Response, error) {
			resp, _ := mockResponse(chooseStatus(attempt == 1))
			return resp, nil
		},
	}
	refresh := func(_ context.Context) (Token, error) {
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	req, err := http.NewRequest(http.MethodPost, "http://collector.example/ingest", strings.NewReader("payload"))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set(attemptIDHeader, newAttemptID())

	resp, err := at.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	seen := base.snapshot()
	if len(seen) != 2 {
		t.Fatalf("base calls = %d, want 2", len(seen))
	}
	for idx, record := range seen {
		if record.body != "payload" {
			t.Fatalf("attempt %d body = %q, want rebuilt payload", idx, record.body)
		}
	}
	if seen[0].auth != "Bearer token-v1" || seen[1].auth != "Bearer token-v2" {
		t.Fatalf("auth sequence = [%s, %s], want [v1, v2]", seen[0].auth, seen[1].auth)
	}
}

func TestUpdateTokenRejectsNonMonotonicVersion(t *testing.T) {
	at := NewAuthTransport(&controllableTransport{
		handler: func(_ *http.Request, _ int) (*http.Response, error) {
			resp, _ := mockResponse(http.StatusOK)
			return resp, nil
		},
	}, Token{Value: "token-v1", Version: 1}, func(context.Context) (Token, error) {
		return Token{Value: "token-v2", Version: 2}, nil
	})

	if err := at.UpdateToken(Token{Value: "token-again", Version: 1}); err == nil {
		t.Fatal("equal version accepted, want monotonic error")
	}
	if err := at.UpdateToken(Token{Value: "token-old", Version: 0}); err == nil {
		t.Fatal("older version accepted, want monotonic error")
	}
	if err := at.UpdateToken(Token{Value: "token-v2", Version: 2}); err != nil {
		t.Fatalf("greater version: %v", err)
	}
	if err := at.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := at.UpdateToken(Token{Value: "token-v3", Version: 3}); !errors.Is(err, ErrTransportClosed) {
		t.Fatalf("update after close err = %v, want %v", err, ErrTransportClosed)
	}
}

func TestRefreshReturningStaleVersionFailsAndRetries(t *testing.T) {
	var refreshCalls atomicInt
	base := &controllableTransport{
		handler: func(_ *http.Request, attempt int) (*http.Response, error) {
			resp, _ := mockResponse(chooseStatus(attempt == 1))
			return resp, nil
		},
	}
	refresh := func(_ context.Context) (Token, error) {
		n := refreshCalls.addAndGet(1)
		if n == 1 {
			return Token{Value: "stale", Version: 1}, nil
		}
		return Token{Value: "token-v2", Version: 2}, nil
	}
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, refresh)

	first, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
	if err == nil {
		t.Fatal("stale refresh result must surface as an error")
	}
	if first != nil {
		t.Fatal("stale refresh must not return a response")
	}

	second, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
	if err != nil {
		t.Fatalf("retry round trip: %v", err)
	}
	if second.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", second.StatusCode)
	}
	_ = second.Body.Close()

	if got := refreshCalls.get(); got != 2 {
		t.Fatalf("refresh calls = %d, want 2", got)
	}
}

func TestSuccessfulResponsePassesThroughWithAuthorization(t *testing.T) {
	base := &controllableTransport{
		handler: func(_ *http.Request, _ int) (*http.Response, error) {
			resp, _ := mockResponse(http.StatusOK)
			return resp, nil
		},
	}
	var refreshCalls atomicInt
	at := NewAuthTransport(base, Token{Value: "token-v1", Version: 1}, func(context.Context) (Token, error) {
		refreshCalls.add(1)
		return Token{Value: "token-v2", Version: 2}, nil
	})

	resp, err := at.RoundTrip(mustRequest(t, http.MethodGet, nil))
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	_ = resp.Body.Close()

	seen := base.snapshot()
	if len(seen) != 1 || seen[0].auth != "Bearer token-v1" {
		t.Fatalf("requests = %+v, want single authorized request", seen)
	}
	if got := refreshCalls.get(); got != 0 {
		t.Fatalf("refresh calls = %d, want 0", got)
	}
}

func TestIsReplayable(t *testing.T) {
	build := func(method string, body io.Reader, withGetBody bool) *http.Request {
		req, err := http.NewRequest(method, "http://collector.example/ingest", body)
		if err != nil {
			t.Fatalf("build request: %v", err)
		}
		if !withGetBody {
			req.GetBody = nil
		}
		return req
	}

	cases := []struct {
		name string
		req  *http.Request
		want bool
	}{
		{"get", build(http.MethodGet, nil, false), true},
		{"head", build(http.MethodHead, nil, false), true},
		{"options", build(http.MethodOptions, nil, false), true},
		{"post without body", build(http.MethodPost, nil, false), true},
		{"post with get body", build(http.MethodPost, strings.NewReader("x"), true), true},
		{"post without get body", build(http.MethodPost, strings.NewReader("x"), false), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isReplayable(tc.req); got != tc.want {
				t.Fatalf("isReplayable = %v, want %v", got, tc.want)
			}
		})
	}
}
