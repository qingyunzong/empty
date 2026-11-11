package q207

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func testRules() *Rules {
	return &Rules{
		Keys: map[string]KeyRule{
			"a":    {},
			"b":    {},
			"tag":  {Repeatable: true},
			"name": {},
		},
		RequireUTF8Values: true,
	}
}

func mustStore(t *testing.T, rules *Rules) *RuleStore {
	t.Helper()
	s, err := NewRuleStore(rules)
	if err != nil {
		t.Fatalf("NewRuleStore: %v", err)
	}
	return s
}

func TestNormalizeBasic(t *testing.T) {
	res, err := Normalize("b=2&a=1&tag=x&tag=y&name=hello+world", testRules())
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	want := "a=1&b=2&name=hello%20world&tag=x&tag=y"
	if res.Canonical != want {
		t.Fatalf("canonical = %q, want %q", res.Canonical, want)
	}
	// Stable order within the same key.
	var tags []string
	for _, p := range res.Pairs {
		if p.Key == "tag" {
			tags = append(tags, p.Value)
		}
	}
	if !reflect.DeepEqual(tags, []string{"x", "y"}) {
		t.Fatalf("tag order = %v", tags)
	}
}

func TestDecodeExactlyOnce(t *testing.T) {
	// %2526 decodes once to the literal string "%26", never to "&".
	res, err := Normalize("a=%2526", testRules())
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if res.Pairs[0].Value != "%26" {
		t.Fatalf("value = %q, want %%26", res.Pairs[0].Value)
	}
	// Re-encoded so a second decode still yields "%26".
	if res.Canonical != "a=%2526" {
		t.Fatalf("canonical = %q", res.Canonical)
	}
	// Double-encoded key: %2561 decodes once to "%61", which is not "a".
	_, err = Normalize("%2561=1", testRules())
	if !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
}

func TestRejections(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		rules *Rules
		want  error
	}{
		{"truncated escape", "a=%2", testRules(), ErrInvalidEscape},
		{"non-hex escape", "a=%zz", testRules(), ErrInvalidEscape},
		{"lone percent", "a=100%", testRules(), ErrInvalidEscape},
		{"escape in key", "%2g=1", testRules(), ErrInvalidEscape},
		{"control in value", "a=%00", testRules(), ErrControlChar},
		{"control in key", "a%09=1", testRules(), ErrControlChar},
		{"delete char", "a=%7f", testRules(), ErrControlChar},
		{"invalid utf8", "a=%ff%fe", testRules(), ErrInvalidUTF8},
		{"unknown key", "z=1", testRules(), ErrUnknownKey},
		{"empty key", "=1", testRules(), ErrUnknownKey},
		{"empty key among pairs", "a=1&=2", testRules(), ErrUnknownKey},
		{"encoded separator in key", "a%3db=1", testRules(), ErrUnknownKey},
		{"key collision", "tag=1&%74ag=2", testRules(), ErrKeyCollision},
		{"collision repeatable", "tag=1&%74%61%67=2", testRules(), ErrKeyCollision},
		{"non-repeatable twice", "a=1&a=2", testRules(), ErrNotRepeatable},
		{"utf8 not required", "a=%ff", &Rules{
			Keys: map[string]KeyRule{"a": {}},
		}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Normalize(tc.raw, tc.rules)
			if tc.want == nil {
				if err != nil {
					t.Fatalf("Normalize(%q) rejected: %v", tc.raw, err)
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("Normalize(%q) err = %v, want %v", tc.raw, err, tc.want)
			}
		})
	}
}

func TestEmptySegmentsSkipped(t *testing.T) {
	res, err := Normalize("a=1&&b=2&", testRules())
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if res.Canonical != "a=1&b=2" {
		t.Fatalf("canonical = %q", res.Canonical)
	}
}

// TestEncodedSeparators verifies that decoded '&' and '=' inside values
// are re-encoded so re-parsing can never split them into new pairs.
func TestEncodedSeparators(t *testing.T) {
	res, err := Normalize("a=x%26b%3dy&name=%3D%26", testRules())
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if res.Canonical != "a=x%26b%3Dy&name=%3D%26" {
		t.Fatalf("canonical = %q", res.Canonical)
	}
	reparsed, err := parseRawQuery(res.Canonical)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if len(reparsed) != 2 {
		t.Fatalf("reparse produced %d pairs, want 2: %v", len(reparsed), reparsed)
	}
	for _, p := range reparsed {
		if p.Key != "a" && p.Key != "name" {
			t.Fatalf("reparse produced new key %q", p.Key)
		}
	}
}

// TestReparseIdempotent guarantees the canonical form is a fixed point:
// normalizing it again yields the same bytes and no new keys.
func TestReparseIdempotent(t *testing.T) {
	raws := []string{
		"a=1&b=2",
		"tag=x&tag=y&tag=z",
		"a=%2B%20%26%3D%25",
		"name=a+b+c",
		"b=%E4%B8%AD%E6%96%87",
		"",
	}
	for _, raw := range raws {
		res, err := Normalize(raw, testRules())
		if err != nil {
			t.Fatalf("Normalize(%q): %v", raw, err)
		}
		again, err := Normalize(res.Canonical, testRules())
		if err != nil {
			t.Fatalf("re-normalize(%q): %v", res.Canonical, err)
		}
		if again.Canonical != res.Canonical {
			t.Fatalf("not idempotent: %q -> %q -> %q", raw, res.Canonical, again.Canonical)
		}
		if again.CanonicalDigest != res.CanonicalDigest {
			t.Fatalf("digest drift for %q", raw)
		}
	}
}

// TestDifferentialAdapters is the acceptance check: for every accepted
// query, the first-value and last-value backend adapters see the same key
// set, and they can only disagree on keys the caller explicitly declared
// repeatable — so a scalar read of a non-repeatable key can never be
// desynchronized between the two parser families.
func TestDifferentialAdapters(t *testing.T) {
	raws := []string{
		"a=1&b=2",
		"tag=1&tag=2&tag=3",
		"a=%2526&b=%253D",
		"name=+%20+",
		"a=x%26y%3Dz",
		"b=%E4%B8%AD",
		"a=1&&&b=2",
		"tag=&tag=v",
		"a",
		"",
	}
	rules := testRules()
	for _, raw := range raws {
		res, err := Normalize(raw, rules)
		if err != nil {
			t.Fatalf("Normalize(%q): %v", raw, err)
		}
		first := FirstValueAdapter(res.Canonical)
		last := LastValueAdapter(res.Canonical)
		all := AllValuesAdapter(res.Canonical)
		if !reflect.DeepEqual(keysOf(first), keysOf(last)) {
			t.Fatalf("key set divergence on %q: first=%v last=%v", raw, first, last)
		}
		for k := range first {
			if first[k] != last[k] && !rules.Keys[k].Repeatable {
				t.Fatalf("scalar divergence on non-repeatable key %q: first=%q last=%q",
					k, first[k], last[k])
			}
			if first[k] != all[k][0] || last[k] != all[k][len(all[k])-1] {
				t.Fatalf("adapter %q inconsistent with ordered values %v", k, all[k])
			}
		}
		// The adapters must see exactly the accepted pairs, in order.
		got := make(map[string][]string)
		for _, p := range res.Pairs {
			got[p.Key] = append(got[p.Key], p.Value)
		}
		if !reflect.DeepEqual(all, got) {
			t.Fatalf("adapter values %v differ from accepted pairs %v", all, got)
		}
	}
}

func keysOf(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// TestDifferentialRawRejected lists hostile raw inputs that must be
// rejected outright so they never reach either backend parser.
func TestDifferentialRawRejected(t *testing.T) {
	raws := []string{
		"a=1&%61=2",  // colliding encodings of the same key
		"a=1&a=2",    // non-repeatable duplicate
		"%2561=1",    // double-encoded key
		"=empty-key", // empty key
		"%3d=1",      // key decodes to "="
		"a%26b=1",    // key decodes to "a&b"
	}
	for _, raw := range raws {
		if _, err := Normalize(raw, testRules()); err == nil {
			t.Fatalf("Normalize(%q) accepted, want rejection", raw)
		}
	}
	// Values that decode once into escape-looking text are accepted; both
	// adapters must agree on the re-encoded canonical form.
	for _, raw := range []string{"a=%2561%2562", "a=1;b=2"} {
		res, err := Normalize(raw, testRules())
		if err != nil {
			t.Fatalf("Normalize(%q): %v", raw, err)
		}
		if !reflect.DeepEqual(FirstValueAdapter(res.Canonical), LastValueAdapter(res.Canonical)) {
			t.Fatalf("adapters diverge on canonical %q", res.Canonical)
		}
	}
	// The semicolon case is accepted as an opaque value.
	res, err := Normalize("a=1;b=2", testRules())
	if err != nil {
		t.Fatalf("Normalize semicolon: %v", err)
	}
	if res.Pairs[0].Value != "1;b=2" {
		t.Fatalf("semicolon value = %q", res.Pairs[0].Value)
	}
}

func TestDigests(t *testing.T) {
	raw := "b=%41&a=+"
	res, err := Normalize(raw, testRules())
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if res.Canonical != "a=%20&b=A" {
		t.Fatalf("canonical = %q", res.Canonical)
	}
	if res.RawDigest != sha256.Sum256([]byte(raw)) {
		t.Fatalf("raw digest mismatch")
	}
	if res.CanonicalDigest != sha256.Sum256([]byte(res.Canonical)) {
		t.Fatalf("canonical digest mismatch")
	}
	if res.RawDigest == res.CanonicalDigest {
		t.Fatalf("digests should differ for non-canonical input")
	}
	// Already-canonical input keeps identical digests.
	res2, err := Normalize(res.Canonical, testRules())
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if res2.RawDigest != res2.CanonicalDigest {
		t.Fatalf("canonical input should have identical digests")
	}
}

func TestHotReload(t *testing.T) {
	s := mustStore(t, &Rules{Keys: map[string]KeyRule{"a": {}}})
	if s.Version() != 1 {
		t.Fatalf("version = %d, want 1", s.Version())
	}
	v, err := s.Update(&Rules{Keys: map[string]KeyRule{"a": {}, "b": {}}})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if v != 2 || s.Version() != 2 {
		t.Fatalf("version = %d/%d, want 2", v, s.Version())
	}
	if _, err := s.Update(&Rules{Keys: map[string]KeyRule{"": {}}}); err == nil {
		t.Fatalf("invalid rules accepted")
	}
	if s.Version() != 2 {
		t.Fatalf("failed update bumped version to %d", s.Version())
	}
}

func TestMiddleware(t *testing.T) {
	s := mustStore(t, &Rules{Keys: map[string]KeyRule{"a": {}, "b": {}}})
	var gotQuery string
	var gotRes *Result
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		gotRes = FromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})
	h := s.Middleware(backend)

	// Accepted request: backend sees canonical bytes and the result.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x?b=%41&a=+", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if gotQuery != "a=%20&b=A" {
		t.Fatalf("backend query = %q", gotQuery)
	}
	if gotRes == nil || gotRes.Version != 1 {
		t.Fatalf("context result = %+v", gotRes)
	}
	if gotRes.RawDigest != sha256.Sum256([]byte("b=%41&a=+")) {
		t.Fatalf("raw digest mismatch")
	}

	// Rejected request: 400, backend not called.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x?z=1", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}

	// Hot reload: new key allowed for subsequent requests, version pinned.
	if _, err := s.Update(&Rules{Keys: map[string]KeyRule{"a": {}, "b": {}, "z": {}}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x?z=9&a=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d after reload", rec.Code)
	}
	if gotRes.Version != 2 {
		t.Fatalf("version = %d, want 2", gotRes.Version)
	}
}

// TestMiddlewareVersionPinned fires a reload concurrently with requests
// and asserts every request reports exactly the version it used.
func TestMiddlewareVersionPinned(t *testing.T) {
	s := mustStore(t, &Rules{Keys: map[string]KeyRule{"a": {}}})
	h := s.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := FromContext(r.Context())
		fmt.Fprint(w, res.Version)
	}))
	done := make(chan struct{})
	go func() {
		defer close(done)
		rules := &Rules{Keys: map[string]KeyRule{"a": {}}}
		for i := 0; i < 50; i++ {
			if _, err := s.Update(rules); err != nil {
				t.Errorf("Update: %v", err)
				return
			}
		}
	}()
	for i := 0; i < 50; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/?a=1", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if strings.TrimSpace(rec.Body.String()) == "" {
			t.Fatalf("empty version body")
		}
	}
	<-done
}
