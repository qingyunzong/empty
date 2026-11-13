package dataeng

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ErrMissingRetryAfter is returned when the Retry-After header is empty.
var ErrMissingRetryAfter = errors.New("dataeng: empty Retry-After header")

// ResolveRetryAfter interprets a Retry-After header value, which may be
// either a number of seconds or an HTTP date, and returns the local time
// until which the caller should back off.
//
// When retryAfter is an HTTP date and dateHeader carries the response's
// Date header, the server's clock skew (server Date minus local now) is
// subtracted so the backoff ends at the correct local instant. Second
// values are relative and need no skew correction. Results in the past
// are clamped to now.
func ResolveRetryAfter(retryAfter, dateHeader string, now time.Time) (time.Time, error) {
	ra := strings.TrimSpace(retryAfter)
	if ra == "" {
		return time.Time{}, ErrMissingRetryAfter
	}
	if secs, err := strconv.ParseInt(ra, 10, 64); err == nil {
		if secs < 0 {
			return time.Time{}, fmt.Errorf("dataeng: negative Retry-After %q", retryAfter)
		}
		return now.Add(time.Duration(secs) * time.Second), nil
	}
	target, err := http.ParseTime(ra)
	if err != nil {
		return time.Time{}, fmt.Errorf("dataeng: invalid Retry-After %q: %w", retryAfter, err)
	}
	if d := strings.TrimSpace(dateHeader); d != "" {
		if serverNow, derr := http.ParseTime(d); derr == nil {
			target = target.Add(-serverNow.Sub(now))
		}
	}
	if target.Before(now) {
		target = now
	}
	return target, nil
}
