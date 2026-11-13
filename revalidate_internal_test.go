package dataeng

import (
	"testing"
	"time"
)

func TestWithinOneSecondSubSecondBoundary(t *testing.T) {
	base := time.Date(2025, time.October, 21, 7, 28, 0, 0, time.UTC)

	cases := []struct {
		name string
		when time.Time
		want bool
	}{
		{name: "exact", when: base, want: true},
		{name: "one millisecond under", when: base.Add(999 * time.Millisecond), want: true},
		{name: "exactly one second", when: base.Add(time.Second), want: true},
		{name: "one millisecond over", when: base.Add(time.Second + time.Millisecond), want: false},
		{name: "negative one millisecond under", when: base.Add(-999 * time.Millisecond), want: true},
		{name: "negative one millisecond over", when: base.Add(-time.Second - time.Millisecond), want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := withinOneSecond(base, tc.when); got != tc.want {
				t.Fatalf("withinOneSecond = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseETagRejectsMalformedValues(t *testing.T) {
	for _, value := range []string{"", "v1", `W/v1`, `"v1`, `v1"`, `*extra`} {
		if _, err := ParseETag(value); err == nil {
			t.Fatalf("ParseETag(%q) unexpectedly succeeded", value)
		}
	}
}

func TestSplitTagListRespectsQuotedCommas(t *testing.T) {
	parts := splitTagList(`"a,b", W/"c", "d"`)
	want := []string{`"a,b"`, ` W/"c"`, ` "d"`}
	if len(parts) != len(want) {
		t.Fatalf("got %d parts %v, want %v", len(parts), parts, want)
	}
	for i := range want {
		if parts[i] != want[i] {
			t.Fatalf("part %d = %q, want %q", i, parts[i], want[i])
		}
	}
}
