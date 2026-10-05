package searchre

import (
	"strings"
	"testing"
	"time"
)

func TestPerfSmoke(t *testing.T) {
	for _, tc := range []struct{ p, s string }{
		{`(a*)*b`, strings.Repeat("a", 100)},
		{`(a|a)*`, strings.Repeat("a", 500)},
		{`((a)*)*b`, strings.Repeat("a", 60)},
		{`(a?)*b`, strings.Repeat("a", 100)},
	} {
		re := MustCompile(tc.p)
		start := time.Now()
		re.findCaps([]rune(tc.s))
		d := time.Since(start)
		t.Logf("pattern %q on %d chars: %v", tc.p, len(tc.s), d)
		if d > 2*time.Second {
			t.Fatalf("pattern %q on %d chars took %v", tc.p, len(tc.s), d)
		}
	}
}
