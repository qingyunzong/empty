package dataeng_test

import (
	"net/http"
	"testing"
	"time"

	dataeng "example.org/dataeng13/q0009"
)

const testDate = "Tue, 21 Oct 2025 07:28:00 GMT"

func header(pairs ...string) http.Header {
	h := http.Header{}
	for i := 0; i < len(pairs); i += 2 {
		h.Set(pairs[i], pairs[i+1])
	}
	return h
}

func TestConditionalHeaders(t *testing.T) {
	t.Run("emits both validators", func(t *testing.T) {
		got, err := dataeng.ConditionalHeaders(header(
			"ETag", `"v1"`,
			"Last-Modified", testDate,
		))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Get("If-None-Match") != `"v1"` {
			t.Fatalf(`If-None-Match = %q, want "v1"`, got.Get("If-None-Match"))
		}
		if got.Get("If-Modified-Since") != testDate {
			t.Fatalf("If-Modified-Since = %q, want %q", got.Get("If-Modified-Since"), testDate)
		}
	})

	t.Run("no validator means no fabricated condition", func(t *testing.T) {
		got, err := dataeng.ConditionalHeaders(header("Content-Length", "12"))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("expected no conditional headers, got %v", got)
		}
	})
}

func TestRangeHeadersRejectsWeakValidator(t *testing.T) {
	weak, err := dataeng.RangeHeaders(header("ETag", `W/"v1"`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(weak) != 0 {
		t.Fatalf("weak ETag must not drive If-Range, got %v", weak)
	}

	strong, err := dataeng.RangeHeaders(header("ETag", `"v1"`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strong.Get("If-Range") != `"v1"` {
		t.Fatalf("If-Range = %q, want strong tag %q", strong.Get("If-Range"), `"v1"`)
	}

	none, err := dataeng.RangeHeaders(header("Content-Length", "12"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("expected no If-Range without validators, got %v", none)
	}
}

func TestETagComparison(t *testing.T) {
	strong := mustTag(t, `"v1"`)
	weak := mustTag(t, `W/"v1"`)
	other := mustTag(t, `"v2"`)

	if strong.WeakEqual(weak) != true {
		t.Fatal("strong tag must satisfy weak comparison")
	}
	if strong.StrongEqual(mustTag(t, `"v1"`)) != true {
		t.Fatal("two strong tags with equal opaque values should strongly match")
	}
	if weak.StrongEqual(strong) != false {
		t.Fatal("a weak tag must not satisfy a strong comparison")
	}
	if weak.StrongEqual(mustTag(t, `W/"v1"`)) != false {
		t.Fatal("two weak tags must not strongly match")
	}
	if strong.WeakEqual(other) != false {
		t.Fatal("different opaque values must not compare equal")
	}

	star := mustTag(t, "*")
	if star.StrongEqual(strong) || star.WeakEqual(strong) {
		t.Fatal("wildcard must never compare equal as an entity-tag")
	}
}

func TestEvaluateWeakETagReuse(t *testing.T) {
	stored := dataeng.CachedEntry{
		Headers: header("ETag", `"v1"`, "Content-Length", "5"),
		Payload: []byte("hello"),
	}
	latest := dataeng.RevalidationResponse{
		Status:  http.StatusNotModified,
		Headers: header("ETag", `W/"v1"`, "Date", testDate),
	}

	got, err := dataeng.Evaluate(stored, latest)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Reuse {
		t.Fatalf("weak match on equal opaque value should reuse, reason=%q", got.Reason)
	}
	if got.Reason != "etag-matched" {
		t.Fatalf("Reason = %q, want etag-matched", got.Reason)
	}
	if string(got.Payload) != "hello" {
		t.Fatalf("payload = %q, want stored body %q", got.Payload, "hello")
	}
	if got.Headers.Get("ETag") != `W/"v1"` {
		t.Fatalf("merged ETag = %q, want W/\"v1\"", got.Headers.Get("ETag"))
	}
	if got.Headers.Get("Date") != testDate {
		t.Fatalf("merged Date = %q, want %q", got.Headers.Get("Date"), testDate)
	}
	if got.Headers.Get("Content-Length") != "5" {
		t.Fatalf("Content-Length = %q, want stored length 5", got.Headers.Get("Content-Length"))
	}
}

func TestEvaluateReuseIgnoresSmuggledBody(t *testing.T) {
	stored := dataeng.CachedEntry{
		Headers: header(
			"ETag", `"v1"`,
			"Content-Length", "5",
			"Cache-Control", "max-age=60",
		),
		Payload: []byte("hello"),
	}
	latest := dataeng.RevalidationResponse{
		Status: http.StatusNotModified,
		Headers: header(
			"ETag", `"v1"`,
			"Content-Length", "99",
			"Cache-Control", "max-age=120",
			"Date", testDate,
		),
		Payload: []byte("injected"),
	}

	got, err := dataeng.Evaluate(stored, latest)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Reuse {
		t.Fatalf("strong match should reuse, reason=%q", got.Reason)
	}
	if string(got.Payload) != "hello" {
		t.Fatalf("payload = %q, smuggled body must not be adopted", got.Payload)
	}
	if got.Headers.Get("Content-Length") != "5" {
		t.Fatalf("Content-Length = %q, new body length must be ignored", got.Headers.Get("Content-Length"))
	}
	if got.Headers.Get("Cache-Control") != "max-age=120" {
		t.Fatalf("Cache-Control = %q, want merged max-age=120", got.Headers.Get("Cache-Control"))
	}
}

func TestEvaluateMultiValueAnyStrongMatch(t *testing.T) {
	stored := dataeng.CachedEntry{
		Headers: header("ETag", `"v1"`),
		Payload: []byte("hello"),
	}
	latest := dataeng.RevalidationResponse{
		Status:  http.StatusNotModified,
		Headers: header("ETag", `"v2", "v1"`),
	}

	got, err := dataeng.Evaluate(stored, latest)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Reuse {
		t.Fatalf("any single strong match should reuse, reason=%q", got.Reason)
	}

	miss := dataeng.RevalidationResponse{
		Status:  http.StatusNotModified,
		Headers: header("ETag", `"v2", "v3"`),
	}
	got, err = dataeng.Evaluate(stored, miss)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Reuse || got.Reason != "etag-mismatch" {
		t.Fatalf("mismatching tags must not reuse, got %+v", got)
	}
}

func TestEvaluateWildcardNeedsStoredBody(t *testing.T) {
	withBody := dataeng.CachedEntry{
		Headers: header("ETag", `"v1"`),
		Payload: []byte("hello"),
	}
	got, err := dataeng.Evaluate(withBody, dataeng.RevalidationResponse{
		Status:  http.StatusNotModified,
		Headers: header("ETag", "*"),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Reuse {
		t.Fatalf("wildcard should match when a body is stored, reason=%q", got.Reason)
	}

	empty := dataeng.CachedEntry{Headers: header("ETag", `"v1"`)}
	got, err = dataeng.Evaluate(empty, dataeng.RevalidationResponse{
		Status:  http.StatusNotModified,
		Headers: header("ETag", "*"),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Reuse || got.Reason != "etag-mismatch" {
		t.Fatalf("wildcard must not match without a stored body, got %+v", got)
	}
}

func TestEvaluateLastModifiedOneSecondBoundary(t *testing.T) {
	base := time.Date(2025, time.October, 21, 7, 28, 0, 0, time.UTC)

	cases := []struct {
		name    string
		delta   time.Duration
		wantUse bool
		reason  string
	}{
		{name: "exact same time", delta: 0, wantUse: true, reason: "last-modified-unchanged"},
		{name: "one second apart stays unchanged", delta: time.Second, wantUse: true, reason: "last-modified-unchanged"},
		{name: "negative one second stays unchanged", delta: -time.Second, wantUse: true, reason: "last-modified-unchanged"},
		{name: "beyond one second forces refetch", delta: 2 * time.Second, wantUse: false, reason: "modified"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stored := dataeng.CachedEntry{
				Headers: header("Last-Modified", base.Format(http.TimeFormat)),
				Payload: []byte("hello"),
			}
			latest := dataeng.RevalidationResponse{
				Status:  http.StatusNotModified,
				Headers: header("Last-Modified", base.Add(tc.delta).Format(http.TimeFormat)),
			}

			got, err := dataeng.Evaluate(stored, latest)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Reuse != tc.wantUse || got.Reason != tc.reason {
				t.Fatalf("got reuse=%v reason=%q, want reuse=%v reason=%q",
					got.Reuse, got.Reason, tc.wantUse, tc.reason)
			}
			if tc.wantUse && string(got.Payload) != "hello" {
				t.Fatalf("payload = %q, want stored body", got.Payload)
			}
		})
	}
}

func TestEvaluateNoValidator(t *testing.T) {
	stored := dataeng.CachedEntry{
		Headers: header("Content-Length", "5"),
		Payload: []byte("hello"),
	}
	got, err := dataeng.Evaluate(stored, dataeng.RevalidationResponse{
		Status:  http.StatusNotModified,
		Headers: header("Date", testDate),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Reuse || got.Reason != "no-validator" {
		t.Fatalf("304 without any validator must not reuse, got %+v", got)
	}
}

func TestEvaluateFullResponseReplacesBody(t *testing.T) {
	stored := dataeng.CachedEntry{
		Headers: header("ETag", `"v1"`),
		Payload: []byte("hello"),
	}
	got, err := dataeng.Evaluate(stored, dataeng.RevalidationResponse{
		Status:  http.StatusOK,
		Headers: header("ETag", `"v2"`, "Content-Length", "10"),
		Payload: []byte("brand-new!"),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Reuse || got.Reason != "full-response" {
		t.Fatalf("200 response must replace rather than reuse, got %+v", got)
	}
	if string(got.Payload) != "brand-new!" {
		t.Fatalf("payload = %q, want new body", got.Payload)
	}
}

func mustTag(t *testing.T, value string) *dataeng.ETag {
	t.Helper()
	tag, err := dataeng.ParseETag(value)
	if err != nil {
		t.Fatalf("ParseETag(%q): %v", value, err)
	}
	return tag
}
