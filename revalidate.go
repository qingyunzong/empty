package dataeng

import (
	"errors"
	"net/http"
	"time"
)

// Reuse reasons returned in Decision.Reason. They are stable strings so
// callers can branch on them without depending on internal helpers.
const (
	ReasonFullResponse = "full-response"
	ReasonETagMismatch = "etag-mismatch"
	ReasonModified     = "modified"
	ReasonNoValidator  = "no-validator"
	ReasonETagMatched  = "etag-matched"
	ReasonLastModified = "last-modified-unchanged"
)

// ErrUnexpectedStatus is returned when a revalidation response carries a
// status that neither provides a fresh representation (200) nor confirms
// that the stored representation still applies (304).
var ErrUnexpectedStatus = errors.New("dataeng: unexpected revalidation status")

// CachedEntry is the locally stored representation. Headers carries the
// stored response headers, Payload the stored body.
type CachedEntry struct {
	Headers http.Header
	Payload []byte
}

// RevalidationResponse is the response received for a conditional request.
// For a 304 Not Modified response Payload is typically empty; any payload
// present is never used when the stored body is reused.
type RevalidationResponse struct {
	Status  int
	Headers http.Header
	Payload []byte
}

// Decision reports whether the stored payload can be kept and, when it is
// reused, the merged headers to store alongside it.
type Decision struct {
	Reuse   bool
	Reason  string
	Headers http.Header
	Payload []byte
}

// mergedHeaders is the allowlist of headers that a 304 response may update
// on the stored representation (RFC 9110, section 15.4.6 / RFC 9111,
// section 4.3.4). Content-Length and other representation metadata are
// deliberately absent: the stored body length stays authoritative.
var mergedHeaders = []string{
	"Cache-Control",
	"Date",
	"ETag",
	"Expires",
	"Last-Modified",
	"Vary",
	"Warning",
	"Age",
}

// ConditionalHeaders builds the conditional request headers implied by the
// validators of a stored representation. It never sends a request itself.
// If the stored entry has no ETag and no parseable Last-Modified value, no
// conditional header is fabricated and an empty header set is returned.
func ConditionalHeaders(stored http.Header) (http.Header, error) {
	out := http.Header{}

	if value := stored.Get("ETag"); value != "" {
		tag, err := ParseETag(value)
		if err != nil {
			return nil, err
		}
		out.Set("If-None-Match", tag.String())
	}

	if value := stored.Get("Last-Modified"); value != "" {
		when, err := http.ParseTime(value)
		if err != nil {
			return nil, err
		}
		out.Set("If-Modified-Since", when.UTC().Format(http.TimeFormat))
	}

	return out, nil
}

// RangeHeaders builds an If-Range validator for a range request. Only a
// strong stored ETag is usable for a ranged strong comparison: a weak ETag
// cannot validate a partial representation, so the returned header set is
// empty and the caller must fetch the full representation. A Last-Modified
// date is emitted only when no ETag is available.
func RangeHeaders(stored http.Header) (http.Header, error) {
	if value := stored.Get("ETag"); value != "" {
		tag, err := ParseETag(value)
		if err != nil {
			return nil, err
		}
		if tag.Wildcard || tag.Weak {
			return http.Header{}, nil
		}
		out := http.Header{}
		out.Set("If-Range", tag.String())
		return out, nil
	}

	if value := stored.Get("Last-Modified"); value != "" {
		when, err := http.ParseTime(value)
		if err != nil {
			return nil, err
		}
		out := http.Header{}
		out.Set("If-Range", when.UTC().Format(http.TimeFormat))
		return out, nil
	}

	return http.Header{}, nil
}

// Evaluate decides whether a revalidation response permits reusing the
// stored payload. A 200 OK means the server sent a new representation and
// the old body must not be reused; a 304 Not Modified is evaluated against
// the stored validators and, on a match, yields merged headers plus the
// original payload.
func Evaluate(stored CachedEntry, latest RevalidationResponse) (*Decision, error) {
	switch latest.Status {
	case http.StatusOK:
		return &Decision{
			Reuse:   false,
			Reason:  ReasonFullResponse,
			Headers: cloneHeader(latest.Headers),
			Payload: latest.Payload,
		}, nil
	case http.StatusNotModified:
		return evaluateNotModified(stored, latest), nil
	default:
		return nil, ErrUnexpectedStatus
	}
}

func evaluateNotModified(stored CachedEntry, latest RevalidationResponse) *Decision {
	if storedValue, latestValue := stored.Headers.Get("ETag"), latest.Headers.Get("ETag"); storedValue != "" || latestValue != "" {
		matched, err := etagReusable(stored, latestValue)
		if err != nil {
			return &Decision{Reuse: false, Reason: ReasonETagMismatch}
		}
		if !matched {
			return &Decision{Reuse: false, Reason: ReasonETagMismatch}
		}
		return reuseStored(stored, latest, ReasonETagMatched)
	}

	if stored.Headers.Get("Last-Modified") == "" || latest.Headers.Get("Last-Modified") == "" {
		return &Decision{Reuse: false, Reason: ReasonNoValidator}
	}

	unchanged, err := lastModifiedUnchanged(stored.Headers, latest.Headers)
	if err != nil || !unchanged {
		return &Decision{Reuse: false, Reason: ReasonModified}
	}

	return reuseStored(stored, latest, ReasonLastModified)
}

// etagReusable implements the entity-tag comparison rules. A wildcard in
// the response matches only when a payload is already stored. Among concrete
// tags, a weak comparison succeeds on equal opaque values, while a strong
// match requires both tags to be strong; any single strong match in a
// multi-valued response is sufficient.
func etagReusable(stored CachedEntry, latestValue string) (bool, error) {
	if latestValue == "" {
		return false, nil
	}

	storedTag, err := ParseETag(stored.Headers.Get("ETag"))
	if err != nil {
		return false, err
	}

	latestTags, err := ParseETags(latestValue)
	if err != nil {
		return false, err
	}

	for _, candidate := range latestTags {
		if candidate.Wildcard {
			if len(stored.Payload) > 0 {
				return true, nil
			}
			continue
		}
		if storedTag.Wildcard {
			if len(stored.Payload) > 0 {
				return true, nil
			}
			continue
		}
		if storedTag.StrongEqual(candidate) || storedTag.WeakEqual(candidate) {
			return true, nil
		}
	}

	return false, nil
}

func lastModifiedUnchanged(stored, latest http.Header) (bool, error) {
	storedValue := stored.Get("Last-Modified")
	latestValue := latest.Get("Last-Modified")
	if storedValue == "" || latestValue == "" {
		return false, errors.New(ReasonNoValidator)
	}

	storedTime, err := http.ParseTime(storedValue)
	if err != nil {
		return false, err
	}
	latestTime, err := http.ParseTime(latestValue)
	if err != nil {
		return false, err
	}

	return withinOneSecond(storedTime, latestTime), nil
}

// withinOneSecond treats modification times differing by at most one second
// as unchanged. The comparison is absolute so clock skew in either direction
// is tolerated; anything beyond the boundary requires a fresh fetch.
func withinOneSecond(a, b time.Time) bool {
	delta := a.Sub(b)
	if delta < 0 {
		delta = -delta
	}
	return delta <= time.Second
}

func reuseStored(stored CachedEntry, latest RevalidationResponse, reason string) *Decision {
	merged := cloneHeader(stored.Headers)
	for _, name := range mergedHeaders {
		if values := latest.Headers.Values(name); len(values) > 0 {
			merged.Del(name)
			for _, value := range values {
				merged.Add(name, value)
			}
		}
	}

	return &Decision{
		Reuse:   true,
		Reason:  reason,
		Headers: merged,
		Payload: stored.Payload,
	}
}

func cloneHeader(in http.Header) http.Header {
	out := make(http.Header, len(in))
	for key, values := range in {
		copied := make([]string, len(values))
		copy(copied, values)
		out[key] = copied
	}
	return out
}
