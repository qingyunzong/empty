package norm

import (
	"bytes"
	"context"
	"testing"
)

// normalizeToString runs the core normalizer over src with the given
// memory budget and returns the normalized output or the first error.
func normalizeToString(t *testing.T, src string, budget int64) (string, error) {
	t.Helper()
	tmp := t.TempDir()
	n := &norm{
		budget: budget,
		tmpDir: tmp,
		segDir: tmp,
		ctx:    context.Background(),
	}
	var out bytes.Buffer
	err := n.parseAll([]byte(src), &out)
	return out.String(), err
}

func mustNormalize(t *testing.T, src string, budget int64) string {
	t.Helper()
	out, err := normalizeToString(t, src, budget)
	if err != nil {
		t.Fatalf("normalize %q: %v", src, err)
	}
	return out
}
