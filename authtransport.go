package dataeng

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
)

// ErrTransportClosed is returned when a RoundTrip is attempted after the
// auth transport has been closed.
var ErrTransportClosed = errors.New("dataeng: auth transport is closed")

// ErrRequestNotReplayable is returned when a request body cannot be rebuilt
// for a replay.
var ErrRequestNotReplayable = errors.New("dataeng: request is not replayable")

// Token is an access token paired with a monotonically increasing version.
// Every newer token must carry a strictly greater Version.
type Token struct {
	// Value is the bearer token sent in the Authorization header.
	Value string
	// Version is the monotonically increasing token version.
	Version int64
}

// RefreshFunc obtains a new token. The returned token must have a version
// strictly greater than the version being refreshed. The context is owned by
// the transport lifecycle: cancelling a waiting request does not cancel a
// refresh, but closing the transport does.
type RefreshFunc func(ctx context.Context) (Token, error)

// AuthTransport is an http.RoundTripper that attaches bearer token
// authentication and coordinates token refreshes across concurrent requests.
//
// On a 401 response, replayable requests trigger at most one refresh per token
// version; concurrent callers for the same version wait for the single refresh
// call. A stale 401 produced by an older token version is retried directly
// with the current token without refreshing. Non-replayable requests receive
// the original 401 unchanged and never trigger a refresh. Replayable requests
// are retried at most once.
type AuthTransport struct {
	base    http.RoundTripper
	refresh RefreshFunc

	mu          sync.Mutex
	token       Token
	refreshes   map[int64]*refreshCall
	closed      bool
	lifecycle   context.Context
	cancel      context.CancelFunc
	closeRunner sync.Once
}

// refreshCall tracks the single refresh for one token version. The entry stays
// in the map until the refresh finishes so every concurrent waiter can join
// the same call; done is closed under mu after the result is published.
type refreshCall struct {
	done chan struct{}
	err  error
}

// NewAuthTransport creates an AuthTransport wrapping base. If base is nil,
// http.DefaultTransport is used. initial is the token currently held by the
// caller and refresh is invoked when a current-version 401 requires a new one.
func NewAuthTransport(base http.RoundTripper, initial Token, refresh RefreshFunc) *AuthTransport {
	if base == nil {
		base = http.DefaultTransport
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &AuthTransport{
		base:      base,
		refresh:   refresh,
		token:     initial,
		refreshes: make(map[int64]*refreshCall),
		lifecycle: ctx,
		cancel:    cancel,
	}
}

// RoundTrip implements http.RoundTripper.
func (t *AuthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := t.snapshotToken()
	if err != nil {
		return nil, err
	}

	resp, err := t.base.RoundTrip(attachToken(req.Clone(req.Context()), token))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusUnauthorized {
		return resp, nil
	}

	if !isReplayable(req) {
		return resp, nil
	}

	current := t.currentToken()
	if current.Version > token.Version {
		return t.replay(req, current, resp)
	}

	refreshed, err := t.ensureRefresh(req.Context(), token.Version)
	if err != nil {
		_ = resp.Body.Close()
		return nil, err
	}

	current = t.currentToken()
	if current.Version > refreshed.Version {
		refreshed = current
	}
	return t.replay(req, refreshed, resp)
}

// UpdateToken rotates the token from outside the transport, for example when
// another component performs the refresh. The version must be strictly greater
// than the current version; in-flight requests holding an older version treat
// their 401 responses as stale and retry without triggering a refresh.
func (t *AuthTransport) UpdateToken(token Token) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return ErrTransportClosed
	}
	if token.Version <= t.token.Version {
		return fmt.Errorf("dataeng: token version %d must be greater than current version %d", token.Version, t.token.Version)
	}
	t.token = token
	return nil
}

// Close ends the transport lifecycle. In-flight refreshes have their context
// canceled, and subsequent RoundTrip calls fail with ErrTransportClosed.
func (t *AuthTransport) Close() error {
	t.closeRunner.Do(func() {
		t.mu.Lock()
		t.closed = true
		t.mu.Unlock()
		t.cancel()
	})
	return nil
}

// ensureRefresh runs at most one refresh for the given version. A caller whose
// context is canceled stops waiting but never cancels the shared refresh,
// which is bound to the transport lifecycle. A late caller joining after the
// refresh finished finds the current token already advanced and returns it
// without starting another refresh.
func (t *AuthTransport) ensureRefresh(ctx context.Context, version int64) (Token, error) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return Token{}, ErrTransportClosed
	}
	if t.token.Version > version {
		token := t.token
		t.mu.Unlock()
		return token, nil
	}

	call, ok := t.refreshes[version]
	if !ok {
		call = &refreshCall{done: make(chan struct{})}
		t.refreshes[version] = call
		go t.runRefresh(version, call)
	}
	done := call.done
	t.mu.Unlock()

	select {
	case <-done:
		t.mu.Lock()
		defer t.mu.Unlock()
		// On success the current token is by definition newer than the
		// version this caller asked for; late waiters use it directly.
		// On failure the entry was removed and call.err carries the cause.
		if call.err == nil || t.token.Version > version {
			return t.token, nil
		}
		if t.closed {
			return Token{}, ErrTransportClosed
		}
		return Token{}, call.err
	case <-ctx.Done():
		// The refresh keeps running independently; only this waiter leaves.
		return Token{}, ctx.Err()
	case <-t.lifecycle.Done():
		<-done
		if call.err != nil {
			return Token{}, call.err
		}
		return Token{}, ErrTransportClosed
	}
}

// runRefresh executes the single refresh for one version and publishes its
// result to every waiter. The map entry is deleted after publication so later
// requests for the same version can try again after a failure instead of
// reusing the stale result.
func (t *AuthTransport) runRefresh(version int64, call *refreshCall) {
	token, err := t.refresh(t.lifecycle)

	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case err != nil:
		call.err = err
	case token.Version <= version:
		call.err = fmt.Errorf("dataeng: refresh returned token version %d, must be greater than %d", token.Version, version)
	case token.Version > t.token.Version:
		t.token = token
	}
	delete(t.refreshes, version)
	close(call.done)
}

// replay closes the original 401 body and performs the single retry with a
// rebuilt request carrying the given token. The retry response is returned to
// the caller untouched, including its body.
func (t *AuthTransport) replay(req *http.Request, token Token, first *http.Response) (*http.Response, error) {
	_ = first.Body.Close()

	retryReq := req.Clone(req.Context())
	if req.Body != nil {
		if req.GetBody == nil {
			return nil, ErrRequestNotReplayable
		}
		body, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		retryReq.Body = body
	}
	return t.base.RoundTrip(attachToken(retryReq, token))
}

func (t *AuthTransport) snapshotToken() (Token, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return Token{}, ErrTransportClosed
	}
	return t.token, nil
}

func (t *AuthTransport) currentToken() Token {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.token
}

func attachToken(req *http.Request, token Token) *http.Request {
	req.Header.Set("Authorization", "Bearer "+token.Value)
	return req
}

// isReplayable reports whether a request can safely be retried. Idempotent
// methods are always replayable; other methods need a rebuildable body.
func isReplayable(req *http.Request) bool {
	switch req.Method {
	case "", http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return req.Body == nil || req.GetBody != nil
}
