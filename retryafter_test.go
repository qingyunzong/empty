package dataeng

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

var retryNow = time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)

func httpDate(t time.Time) string { return t.UTC().Format(http.TimeFormat) }

func TestResolveRetryAfterSeconds(t *testing.T) {
	got, err := ResolveRetryAfter("120", "", retryNow)
	if err != nil {
		t.Fatal(err)
	}
	if want := retryNow.Add(120 * time.Second); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveRetryAfterDateNoSkew(t *testing.T) {
	got, err := ResolveRetryAfter(httpDate(retryNow.Add(90*time.Second)), httpDate(retryNow), retryNow)
	if err != nil {
		t.Fatal(err)
	}
	if want := retryNow.Add(90 * time.Second); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveRetryAfterDateServerAhead(t *testing.T) {
	// Server clock is 30s ahead; its Retry-After date is 60s in its own
	// future, so locally the freeze must end 60s from now, not 90s.
	serverNow := retryNow.Add(30 * time.Second)
	got, err := ResolveRetryAfter(httpDate(serverNow.Add(60*time.Second)), httpDate(serverNow), retryNow)
	if err != nil {
		t.Fatal(err)
	}
	if want := retryNow.Add(60 * time.Second); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveRetryAfterDateServerBehind(t *testing.T) {
	// Server clock is 30s behind; its Retry-After date is 60s in its own
	// future, so locally the freeze ends 60s from now.
	serverNow := retryNow.Add(-30 * time.Second)
	got, err := ResolveRetryAfter(httpDate(serverNow.Add(60*time.Second)), httpDate(serverNow), retryNow)
	if err != nil {
		t.Fatal(err)
	}
	if want := retryNow.Add(60 * time.Second); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveRetryAfterSecondsIgnoresSkew(t *testing.T) {
	got, err := ResolveRetryAfter("45", httpDate(retryNow.Add(time.Hour)), retryNow)
	if err != nil {
		t.Fatal(err)
	}
	if want := retryNow.Add(45 * time.Second); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResolveRetryAfterPastDateClampsToNow(t *testing.T) {
	got, err := ResolveRetryAfter(httpDate(retryNow.Add(-time.Minute)), "", retryNow)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Equal(retryNow) {
		t.Fatalf("got %v, want %v", got, retryNow)
	}
}

func TestResolveRetryAfterInvalid(t *testing.T) {
	if _, err := ResolveRetryAfter("", "", retryNow); !errors.Is(err, ErrMissingRetryAfter) {
		t.Fatalf("empty: got %v", err)
	}
	if _, err := ResolveRetryAfter("not-a-date", "", retryNow); err == nil {
		t.Fatal("garbage: expected error")
	}
	if _, err := ResolveRetryAfter("-5", "", retryNow); err == nil {
		t.Fatal("negative: expected error")
	}
}
