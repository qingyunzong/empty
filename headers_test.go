package dataeng

import (
	"net/http"
	"testing"
	"time"
)

func TestParseFeedbackAllScopes(t *testing.T) {
	now := time.Now()
	h := http.Header{}
	h.Set("Date", now.UTC().Format(http.TimeFormat))
	h.Set("RateLimit-Limit", "100")
	h.Set("RateLimit-Remaining", "90")
	h.Set("RateLimit-Reset", "60")
	h.Set("X-RateLimit-Reset-Tenant", "30")
	h.Set("X-RateLimit-Remaining-Resource", "5")
	h.Set("X-RateLimit-Reset-Method", "10")

	fb := ParseFeedback(h, now)

	if fb.ServerTime.IsZero() {
		t.Fatal("ServerTime not parsed from Date header")
	}
	if fb.Global == nil || fb.Global.Limit != 100 || fb.Global.Remaining != 90 {
		t.Fatalf("global hint = %+v, want limit 100 remaining 90", fb.Global)
	}
	if d := fb.Global.ResetAt.Sub(now); d < 59*time.Second || d > 61*time.Second {
		t.Fatalf("global reset = %v from now, want ~60s (delta seconds)", d)
	}
	if fb.Tenant == nil || fb.Tenant.Remaining != 0 {
		t.Fatalf("tenant hint = %+v, want bare reset to mean exhausted", fb.Tenant)
	}
	if d := fb.Tenant.ResetAt.Sub(now); d < 29*time.Second || d > 31*time.Second {
		t.Fatalf("tenant reset = %v from now, want ~30s", d)
	}
	if fb.Resource == nil || fb.Resource.Remaining != 5 || !fb.Resource.ResetAt.IsZero() {
		t.Fatalf("resource hint = %+v, want remaining 5 and no reset", fb.Resource)
	}
	if fb.Method == nil || fb.Method.Remaining != 0 {
		t.Fatalf("method hint = %+v, want bare reset to mean exhausted", fb.Method)
	}
}

func TestParseFeedbackRetryAfter(t *testing.T) {
	now := time.Now()

	h := http.Header{}
	h.Set("Retry-After", "2")
	fb := ParseFeedback(h, now)
	if fb.Global == nil || fb.Global.Remaining != 0 {
		t.Fatalf("global hint = %+v, want Retry-After to exhaust the bucket", fb.Global)
	}
	if d := fb.Global.ResetAt.Sub(now); d < 1900*time.Millisecond || d > 2100*time.Millisecond {
		t.Fatalf("reset = %v from now, want ~2s", d)
	}

	// HTTP-date form.
	h = http.Header{}
	h.Set("Retry-After", now.Add(3*time.Second).UTC().Format(http.TimeFormat))
	fb = ParseFeedback(h, now)
	if fb.Global == nil {
		t.Fatal("Retry-After HTTP-date not parsed")
	}
	if d := fb.Global.ResetAt.Sub(now); d < 2*time.Second || d > 4*time.Second {
		t.Fatalf("reset = %v from now, want ~3s", d)
	}
}

func TestParseResetEpochAndGarbage(t *testing.T) {
	now := time.Now()
	if got := parseReset("1893456000", now); !got.Equal(time.Unix(1893456000, 0)) {
		t.Fatalf("epoch reset = %v", got)
	}
	if got := parseReset("not-a-date", now); !got.IsZero() {
		t.Fatalf("garbage reset = %v, want zero", got)
	}
	if got := parseReset("-5", now); !got.Equal(now) {
		t.Fatalf("negative delta reset = %v, want now", got)
	}
}

func TestParseFeedbackOmitsSilentScopes(t *testing.T) {
	fb := ParseFeedback(http.Header{}, time.Now())
	if fb.Global != nil || fb.Tenant != nil || fb.Resource != nil || fb.Method != nil {
		t.Fatalf("empty headers produced hints: %+v", fb)
	}
}
