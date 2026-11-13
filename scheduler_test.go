package dataeng

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeFetcher records the order and time of every dispatched fetch.
type fakeFetcher struct {
	mu        sync.Mutex
	started   []string
	startedAt []time.Time
	redirects map[string]string
	release   chan struct{} // if non-nil, every fetch blocks on it
}

func (f *fakeFetcher) Fetch(ctx context.Context, rawURL string) (FetchResult, error) {
	f.mu.Lock()
	f.started = append(f.started, rawURL)
	f.startedAt = append(f.startedAt, time.Now())
	redirect := f.redirects[rawURL]
	release := f.release
	f.mu.Unlock()
	if release != nil {
		<-release
	}
	return FetchResult{URL: rawURL, StatusCode: 200, RedirectTo: redirect}, nil
}

func (f *fakeFetcher) snapshot() ([]string, []time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.started...), append([]time.Time(nil), f.startedAt...)
}

func run(t *testing.T, s *Scheduler) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestIntervalQueuesNewAddresses(t *testing.T) {
	f := &fakeFetcher{}
	s := NewScheduler(f)
	s.RegisterDomain("a.example", 120*time.Millisecond)
	if err := s.Add("http://a.example/one"); err != nil {
		t.Fatal(err)
	}
	if err := s.Add("http://a.example/two"); err != nil {
		t.Fatal(err)
	}
	run(t, s)

	sent := s.Sent()
	if len(sent) != 2 {
		t.Fatalf("sent %d fetches, want 2", len(sent))
	}
	if gap := sent[1].At.Sub(sent[0].At); gap < 100*time.Millisecond {
		t.Fatalf("second fetch sent %v after the first, want >= ~120ms", gap)
	}
}

func TestLexicographicallySmallerAddressGoesFirst(t *testing.T) {
	f := &fakeFetcher{}
	s := NewScheduler(f)
	s.RegisterDomain("a.example", 0)
	s.RegisterDomain("z.example", 0)
	// Both domains are due immediately; the smaller URL string wins.
	if err := s.Add("http://z.example/a"); err != nil {
		t.Fatal(err)
	}
	if err := s.Add("http://a.example/z"); err != nil {
		t.Fatal(err)
	}
	// Same domain: queued addresses are also sent smallest first.
	if err := s.Add("http://a.example/b"); err != nil {
		t.Fatal(err)
	}
	if err := s.Add("http://a.example/a"); err != nil {
		t.Fatal(err)
	}
	run(t, s)

	sent := s.Sent()
	want := []string{
		"http://a.example/a",
		"http://a.example/b",
		"http://a.example/z",
		"http://z.example/a",
	}
	if len(sent) != len(want) {
		t.Fatalf("sent %v, want %v", sent, want)
	}
	for i := range want {
		if sent[i].URL != want[i] {
			t.Fatalf("sent %v, want %v", sent, want)
		}
	}
}

func TestRedirectUsesTargetDomainInterval(t *testing.T) {
	f := &fakeFetcher{redirects: map[string]string{
		"http://a.example/first": "http://b.example/landing",
	}}
	s := NewScheduler(f)
	s.RegisterDomain("a.example", 200*time.Millisecond)
	s.RegisterDomain("b.example", 0) // target may send immediately
	if err := s.Add("http://a.example/first"); err != nil {
		t.Fatal(err)
	}
	if err := s.Add("http://a.example/second"); err != nil {
		t.Fatal(err)
	}
	run(t, s)

	sent := s.Sent()
	if len(sent) != 3 {
		t.Fatalf("sent %v, want 3 fetches", sent)
	}
	// The redirect target goes out before the second a.example address:
	// b.example's own interval allows it, while a.example is still cooling down.
	if sent[1].URL != "http://b.example/landing" {
		t.Fatalf("second send = %q, want the redirect target", sent[1].URL)
	}
	// The original domain's interval is not extended by the redirect:
	// its second address still goes out one interval after its first.
	if gap := sent[2].At.Sub(sent[0].At); gap < 170*time.Millisecond || gap > 400*time.Millisecond {
		t.Fatalf("a.example second send came %v after its first, want ~200ms", gap)
	}
}

func TestMissingIntervalRejectsNewSends(t *testing.T) {
	s := NewScheduler(&fakeFetcher{})
	err := s.Add("http://nope.example/")
	if !errors.Is(err, ErrDomainNotRegistered) {
		t.Fatalf("Add error = %v, want ErrDomainNotRegistered", err)
	}
}

func TestInFlightSurvivesIntervalChanges(t *testing.T) {
	release := make(chan struct{})
	f := &fakeFetcher{release: release}
	s := NewScheduler(f)
	s.RegisterDomain("a.example", 0)
	if err := s.Add("http://a.example/slow"); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() { done <- s.Run(context.Background()) }()

	// Wait until the fetch is actually in flight.
	deadline := time.After(5 * time.Second)
	for {
		started, _ := f.snapshot()
		if len(started) == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("fetch never started")
		case <-time.After(time.Millisecond):
		}
	}

	// Changing and then removing the interval must not cancel the
	// in-flight request, and the domain must refuse new sends.
	s.RegisterDomain("a.example", time.Hour)
	s.UnregisterDomain("a.example")
	if err := s.Add("http://a.example/new"); !errors.Is(err, ErrDomainNotRegistered) {
		t.Fatalf("Add after unregister = %v, want ErrDomainNotRegistered", err)
	}

	close(release)
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
	results := s.Results()
	if len(results) != 1 || results[0].URL != "http://a.example/slow" {
		t.Fatalf("results = %v, want the in-flight fetch to complete", results)
	}
}
