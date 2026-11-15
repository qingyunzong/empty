package robots

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var (
	// ErrRobotsNotFound represents a 404/410 (or another unavailable 4xx)
	// response. It is a valid "no restrictions" outcome, not a network failure.
	ErrRobotsNotFound = errors.New("robots: not found")
	// ErrRobotsAccessDenied represents 401/403. RFC 9309 treats this as a
	// complete disallow.
	ErrRobotsAccessDenied = errors.New("robots: access denied")
	// ErrRobotsUnavailable represents a transport error, 429 or 5xx response.
	ErrRobotsUnavailable = errors.New("robots: unavailable")
	// ErrRobotsTooLarge means the response exceeded the configured limit.
	ErrRobotsTooLarge = errors.New("robots: response too large")
	// ErrCrossOriginRedirect rejects redirects that leave the policy origin.
	ErrCrossOriginRedirect = errors.New("robots: cross-origin redirect")
)

// FetchError carries an HTTP status code together with a sentinel cause.
type FetchError struct {
	StatusCode int
	Err        error
}

func (e *FetchError) Error() string {
	if e.StatusCode == 0 {
		return e.Err.Error()
	}
	return fmt.Sprintf("%v (status %d)", e.Err, e.StatusCode)
}

// Unwrap exposes the sentinel cause to errors.Is.
func (e *FetchError) Unwrap() error {
	return e.Err
}

// Fetcher obtains the raw robots.txt body for an origin.
type Fetcher interface {
	Fetch(ctx context.Context, origin Origin, userAgent string) ([]byte, error)
}

// FetchFunc adapts a function to Fetcher.
type FetchFunc func(ctx context.Context, origin Origin, userAgent string) ([]byte, error)

// Fetch calls f.
func (f FetchFunc) Fetch(ctx context.Context, origin Origin, userAgent string) ([]byte, error) {
	return f(ctx, origin, userAgent)
}

// HTTPFetcherConfig configures HTTPFetcher.
type HTTPFetcherConfig struct {
	Client       *http.Client
	MaxBodyBytes int64
	Timeout      time.Duration
}

// HTTPFetcher fetches robots.txt over HTTP(S). Redirects may not leave the
// original origin, which prevents a tenant's policy from being replaced by a
// third-party document.
type HTTPFetcher struct {
	client       *http.Client
	maxBodyBytes int64
}

// NewHTTPFetcher creates an HTTP fetcher. The default response limit is
// 512 KiB and the default timeout is 15 seconds.
func NewHTTPFetcher(cfg HTTPFetcherConfig) *HTTPFetcher {
	maxBodyBytes := cfg.MaxBodyBytes
	if maxBodyBytes == 0 {
		maxBodyBytes = 512 << 10
	}

	client := cfg.Client
	if client == nil {
		client = &http.Client{}
	}
	clientCopy := *client
	if cfg.Timeout > 0 {
		clientCopy.Timeout = cfg.Timeout
	} else if clientCopy.Timeout == 0 {
		clientCopy.Timeout = 15 * time.Second
	}

	fetcher := &HTTPFetcher{client: &clientCopy, maxBodyBytes: maxBodyBytes}
	previous := client.CheckRedirect
	clientCopy.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		target, err := OriginFromURL(req.URL)
		if err != nil || !sameOrigin(target, originFromRequest(via)) {
			return fmt.Errorf("%w: %s", ErrCrossOriginRedirect, req.URL.Redacted())
		}
		if previous != nil {
			return previous(req, via)
		}
		if len(via) >= 10 {
			return errors.New("robots: stopped after 10 redirects")
		}
		return nil
	}
	return fetcher
}

func originFromRequest(via []*http.Request) Origin {
	if len(via) == 0 {
		return Origin{}
	}
	origin, _ := OriginFromURL(via[0].URL)
	return origin
}

// Fetch implements Fetcher.
func (f *HTTPFetcher) Fetch(ctx context.Context, origin Origin, userAgent string) ([]byte, error) {
	if f == nil || f.client == nil {
		return nil, fmt.Errorf("%w: nil HTTP fetcher", ErrRobotsUnavailable)
	}
	canonical, err := origin.Canonical()
	if err != nil {
		return nil, err
	}
	origin = canonical
	if userAgent == "" {
		userAgent = "q0216-robots/1.0"
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin.RobotsURL(), nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRobotsUnavailable, err)
	}
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Accept", "text/plain, */*;q=0.1")

	response, err := f.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %w", ErrRobotsUnavailable, err)
	}
	defer response.Body.Close()

	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsAccessDenied}
	case response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone:
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsNotFound}
	case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500:
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsUnavailable}
	case response.StatusCode >= 300 && response.StatusCode < 400:
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsUnavailable}
	case response.StatusCode >= 400 && response.StatusCode < 500:
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsNotFound}
	default:
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsUnavailable}
	}

	limit := f.maxBodyBytes
	if limit <= 0 {
		limit = 512 << 10
	}
	if response.ContentLength > limit {
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsTooLarge}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %v", ErrRobotsUnavailable, err)
	}
	if int64(len(body)) > limit {
		return nil, &FetchError{StatusCode: response.StatusCode, Err: ErrRobotsTooLarge}
	}
	return body, nil
}

func sameOrigin(a, b Origin) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) &&
		strings.EqualFold(a.Host, b.Host) &&
		a.Port == b.Port
}
