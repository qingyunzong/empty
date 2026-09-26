package counterrate

import (
	"strings"
	"testing"
	"time"
)

const fixture = `# synthesized telemetry, deliberately shuffled
{"ts":"2026-09-27T00:00:30Z","value":25}
{"ts":"2026-09-27T00:00:00Z","value":100}
{"ts":"2026-09-27T00:00:20Z","value":5,"restart":true}
{"ts":"2026-09-27T00:00:10Z","value":140}
{"ts":1790467240,"value":40}
`

func TestReplayFixtureShuffled(t *testing.T) {
	s := NewSeries(ConflictLastWins)
	n, err := ReplayFixture(strings.NewReader(fixture), s)
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("replayed %d samples, want 5", n)
	}
	start := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	r, err := s.WindowRate(start, start.Add(40*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	// seg1: 100 -> 140 (+40); seg2 (restart at t=20): 5 -> 25 -> 40 (+35).
	if r.Resets != 1 || r.Uncertain {
		t.Fatalf("unexpected flags: %+v", r)
	}
	if !almost(r.Increase, 75) {
		t.Fatalf("increase=%v want 75", r.Increase)
	}
}
