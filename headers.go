package dataeng

import (
	"net/http"
	"strconv"
	"time"
)

// ParseFeedback builds Feedback from response headers. now resolves
// delta-seconds values (Retry-After, sub-epoch RateLimit-Reset) into
// absolute times.
//
// Recognized headers:
//
//	Date                                  server clock, for skew correction
//	Retry-After                           global throttle signal
//	RateLimit-Limit/Remaining/Reset       global scope (X-RateLimit-* too)
//	X-RateLimit-*-Tenant                  tenant scope
//	X-RateLimit-*-Resource                resource scope
//	X-RateLimit-*-Method                  method scope
//
// A reset value is either an HTTP-date, a unix epoch (>= 1e9), or delta
// seconds from now. A scope that reports only a reset time is treated as
// exhausted until that time.
func ParseFeedback(h http.Header, now time.Time) Feedback {
	fb := Feedback{}
	if d := h.Get("Date"); d != "" {
		if t, err := http.ParseTime(d); err == nil {
			fb.ServerTime = t
		}
	}
	fb.Global = parseScope(h, now, "", "RateLimit", "X-RateLimit")
	fb.Tenant = parseScope(h, now, "Tenant", "X-RateLimit")
	fb.Resource = parseScope(h, now, "Resource", "X-RateLimit")
	fb.Method = parseScope(h, now, "Method", "X-RateLimit")
	if ra := h.Get("Retry-After"); ra != "" {
		if fb.Global == nil {
			fb.Global = &Hint{Remaining: -1, Limit: -1}
		}
		fb.Global.ResetAt = parseReset(ra, now)
		if fb.Global.Remaining < 0 {
			fb.Global.Remaining = 0
		}
	}
	return fb
}

// parseScope reads Limit/Remaining/Reset headers for one scope. suffix is
// the scope tag appended to the header name ("" for the global scope), and
// prefixes are the acceptable header families. It returns nil when the
// response says nothing about the scope.
func parseScope(h http.Header, now time.Time, suffix string, prefixes ...string) *Hint {
	get := func(field string) string {
		for _, p := range prefixes {
			name := p + "-" + field
			if suffix != "" {
				name += "-" + suffix
			}
			if v := h.Get(name); v != "" {
				return v
			}
		}
		return ""
	}
	limit, lok := parseIntHeader(get("Limit"))
	remaining, rok := parseIntHeader(get("Remaining"))
	reset := get("Reset")
	if !lok && !rok && reset == "" {
		return nil
	}
	hint := &Hint{Remaining: -1, Limit: -1}
	if lok {
		hint.Limit = limit
	}
	if rok {
		hint.Remaining = remaining
	}
	if reset != "" {
		hint.ResetAt = parseReset(reset, now)
		if !rok {
			// A bare reset header is a throttle signal: treat the
			// bucket as exhausted until the reset time.
			hint.Remaining = 0
		}
	}
	return hint
}

func parseIntHeader(v string) (int, bool) {
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// parseReset interprets a reset header value as an HTTP-date, a unix epoch
// (values >= 1e9), or delta seconds from now.
func parseReset(v string, now time.Time) time.Time {
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		if n >= 1_000_000_000 {
			return time.Unix(n, 0)
		}
		if n < 0 {
			n = 0
		}
		return now.Add(time.Duration(n) * time.Second)
	}
	if t, err := http.ParseTime(v); err == nil {
		return t
	}
	return time.Time{}
}
