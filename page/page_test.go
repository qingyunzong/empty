package page

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"sort"
	"sync"
	"testing"
)

// memReader is an in-memory, concurrency-safe Reader. It counts out-of-range
// requests and returns an error for them so tests can prove the package never
// asks for an index outside the page.
type memReader struct {
	mu       sync.Mutex
	entries  []Entry
	badCalls int
	readSeq  []int
}

func newMemReader(entries []Entry) *memReader {
	cp := make([]Entry, len(entries))
	for i, e := range entries {
		cp[i] = Entry{
			Shared: e.Shared,
			Suffix: append([]byte(nil), e.Suffix...),
			Value:  append([]byte(nil), e.Value...),
		}
	}
	return &memReader{entries: cp}
}

var errOutOfRange = errors.New("test reader: index out of range")

func (m *memReader) ReadEntry(index int) (Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if index < 0 || index >= len(m.entries) {
		m.badCalls++
		return Entry{}, fmt.Errorf("%w: %d", errOutOfRange, index)
	}
	m.readSeq = append(m.readSeq, index)
	e := m.entries[index]
	// Return independent byte slices to emulate a fresh decode per call.
	return Entry{
		Shared: e.Shared,
		Suffix: append([]byte(nil), e.Suffix...),
		Value:  append([]byte(nil), e.Value...),
	}, nil
}

func (m *memReader) badReads() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.badCalls
}

// decompress is the full-decompression reference used by every test: it
// rebuilds all full keys in order and checks prefix validity independently of
// the package implementation.
func decompress(t *testing.T, entries []Entry) [][]byte {
	t.Helper()
	keys := make([][]byte, len(entries))
	var prev []byte
	for i, e := range entries {
		if e.Shared < 0 || e.Shared > len(prev) {
			t.Fatalf("reference: entry %d invalid shared %d", i, e.Shared)
		}
		key := make([]byte, 0, e.Shared+len(e.Suffix))
		key = append(key, prev[:e.Shared]...)
		key = append(key, e.Suffix...)
		keys[i] = key
		prev = key
	}
	return keys
}

func compress(keys, values [][]byte, restarts []int) []Entry {
	entries := make([]Entry, len(keys))
	restartSet := make(map[int]struct{}, len(restarts))
	for _, r := range restarts {
		restartSet[r] = struct{}{}
	}
	var prev []byte
	for i, key := range keys {
		if _, ok := restartSet[i]; ok || i == 0 {
			entries[i] = Entry{Shared: 0, Suffix: append([]byte(nil), key...), Value: append([]byte(nil), values[i]...)}
		} else {
			shared := 0
			for shared < len(prev) && shared < len(key) && prev[shared] == key[shared] {
				shared++
			}
			entries[i] = Entry{Shared: shared, Suffix: append([]byte(nil), key[shared:]...), Value: append([]byte(nil), values[i]...)}
		}
		prev = key
	}
	return entries
}

func equalKeySets(a, b [][]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			return false
		}
	}
	return true
}

func intsEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// prefixBefore returns a key that sorts immediately before s while sharing as
// many leading bytes as possible (truncate the final byte).
func prefixBefore(s []byte) []byte {
	if len(s) == 0 {
		return []byte{}
	}
	out := append([]byte(nil), s[:len(s)-1]...)
	if len(out) == 0 {
		return []byte{0}
	}
	return out
}

func TestEmptyPage(t *testing.T) {
	reader := newMemReader(nil)
	p, err := Open(reader, 0, nil)
	if err != nil {
		t.Fatalf("Open empty page: %v", err)
	}
	if p.Count() != 0 || len(p.RestartPoints()) != 0 {
		t.Fatalf("empty page metadata mismatch: count=%d restarts=%v", p.Count(), p.RestartPoints())
	}
	if got := p.VerifyAccess(); len(got) != 0 {
		t.Fatalf("empty page verified accesses = %v", got)
	}
	res, ok, err := p.LowerBound([]byte("anything"))
	if err != nil || ok || res != nil {
		t.Fatalf("empty page LowerBound = %v ok=%v err=%v", res, ok, err)
	}
	if reader.badReads() != 0 {
		t.Fatalf("out-of-range reads on empty page: %d", reader.badReads())
	}

	// Reference: full decompression of zero entries yields zero keys.
	if got := decompress(t, nil); len(got) != 0 {
		t.Fatalf("reference decompression not empty: %v", got)
	}

	if _, err := Open(newMemReader(nil), 0, []int{0}); !errors.Is(err, ErrEmptyPageRestarts) {
		t.Fatalf("empty page with restarts err = %v, want ErrEmptyPageRestarts", err)
	}
}

func TestRestartIndexOutOfRange(t *testing.T) {
	keys := [][]byte{[]byte("a"), []byte("b")}
	vals := [][]byte{nil, nil}
	entries := compress(keys, vals, []int{0})

	for _, bad := range [][]int{{-1}, {2}, {0, 2}, {1, 1}} {
		reader := newMemReader(entries)
		_, err := Open(reader, len(entries), bad)
		if !errors.Is(err, ErrRestartOutOfRange) {
			t.Fatalf("restarts %v: err = %v, want ErrRestartOutOfRange", bad, err)
		}
		if reader.badReads() != 0 {
			t.Fatalf("restart validation must not read entries, got %d bad reads", reader.badReads())
		}
	}

	if _, err := Open(nil, 1, nil); err == nil {
		t.Fatal("nil reader must be rejected")
	}
	if _, err := Open(newMemReader(entries), -1, nil); err == nil {
		t.Fatal("negative count must be rejected")
	}
}

func TestInvalidPrefix(t *testing.T) {
	// Shared length longer than the previous key.
	bad := []Entry{
		{Shared: 0, Suffix: []byte("abc")},
		{Shared: 4, Suffix: []byte("d")},
	}
	if _, err := Open(newMemReader(bad), 2, []int{0}); !errors.Is(err, ErrInvalidPrefix) {
		t.Fatalf("over-long prefix err = %v", err)
	}

	// Negative shared length.
	neg := []Entry{{Shared: -1, Suffix: []byte("x")}}
	if _, err := Open(newMemReader(neg), 1, []int{0}); !errors.Is(err, ErrInvalidPrefix) {
		t.Fatalf("negative prefix err = %v", err)
	}

	// A restart entry must carry a zero prefix.
	keys := [][]byte{[]byte("apple"), []byte("applet")}
	entries := compress(keys, [][]byte{nil, nil}, []int{0})
	entries[1].Shared = 3
	if _, err := Open(newMemReader(entries), 2, []int{0, 1}); !errors.Is(err, ErrInvalidPrefix) {
		t.Fatalf("non-zero restart prefix err = %v", err)
	}
}

func TestDuplicateAndOutOfOrderKeys(t *testing.T) {
	dup := []Entry{
		{Shared: 0, Suffix: []byte("k")},
		{Shared: 1, Suffix: nil},
	}
	if _, err := Open(newMemReader(dup), 2, []int{0}); !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("duplicate key err = %v", err)
	}

	// Decreasing keys, even with a zero-prefix restart.
	dec := []Entry{
		{Shared: 0, Suffix: []byte("b")},
		{Shared: 0, Suffix: []byte("a")},
	}
	if _, err := Open(newMemReader(dec), 2, []int{0, 1}); !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("out-of-order key err = %v", err)
	}
}

func TestPrefixKeysAndRebuildChain(t *testing.T) {
	keys := [][]byte{
		[]byte("apple"),
		[]byte("apples"),
		[]byte("application"),
		[]byte("banana"),
		[]byte("band"),
	}
	vals := [][]byte{
		[]byte("v0"), []byte("v1"), []byte("v2"), []byte("v3"), []byte("v4"),
	}
	restarts := []int{0, 3}
	entries := compress(keys, vals, restarts)

	// Reference: full decompression must reproduce all original keys.
	if got := decompress(t, entries); !equalKeySets(got, keys) {
		t.Fatalf("reference decompression mismatch:\n got=%v\nwant=%v", got, keys)
	}
	if entries[1].Shared != 5 || entries[2].Shared != 4 || entries[3].Shared != 0 || entries[4].Shared != 3 {
		t.Fatalf("unexpected shared lengths: %+v", entries)
	}

	reader := newMemReader(entries)
	p, err := Open(reader, len(entries), restarts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := p.VerifyAccess(); !intsEqual(got, []int{0, 1, 2, 3, 4}) {
		t.Fatalf("verify access = %v, want full sequential scan", got)
	}

	cases := []struct {
		target string
		index  int
		chain  []int
	}{
		// Before everything: start at index 0, no restart selected.
		{"", 0, []int{0}},
		{"a", 0, []int{0}},
		// Between restart 0 and restart 3: rebuild from entry 0.
		{"apple", 0, []int{0}},
		{"apples", 1, []int{0, 1}},
		{"applex", 2, []int{0, 1, 2}},
		// Exact restart key: the last restart strictly smaller is still 0,
		// so rebuilding walks the whole prefix chain to the hit.
		{"banana", 3, []int{0, 1, 2, 3}},
		{"band", 4, []int{3, 4}},
		{"c", -1, nil},
	}
	for _, tc := range cases {
		res, ok, err := p.LowerBound([]byte(tc.target))
		if err != nil {
			t.Fatalf("LowerBound(%q): %v", tc.target, err)
		}
		if tc.index < 0 {
			if ok {
				t.Fatalf("LowerBound(%q) unexpectedly hit %d", tc.target, res.Index)
			}
			continue
		}
		if !ok || res.Index != tc.index {
			t.Fatalf("LowerBound(%q) index = %v ok=%v, want %d", tc.target, res, ok, tc.index)
		}
		if !bytes.Equal(res.Key, keys[tc.index]) || !bytes.Equal(res.Value, vals[tc.index]) {
			t.Fatalf("LowerBound(%q) payload = %q/%q, want %q/%q",
				tc.target, res.Key, res.Value, keys[tc.index], vals[tc.index])
		}
		if !intsEqual(res.RebuildChain, tc.chain) {
			t.Fatalf("LowerBound(%q) chain = %v, want %v", tc.target, res.RebuildChain, tc.chain)
		}
	}

	// Every index used in every query must be a valid page index.
	for _, idx := range p.QueryAccess() {
		if idx < 0 || idx >= p.Count() {
			t.Fatalf("query access pointed outside page: %d", idx)
		}
	}
	// Verify and query traces are recorded separately.
	if !intsEqual(p.VerifyAccess(), []int{0, 1, 2, 3, 4}) {
		t.Fatal("verify access trace mutated by queries")
	}
	if reader.badReads() != 0 {
		t.Fatalf("package issued out-of-range reads: %d", reader.badReads())
	}
}

func TestEveryRestartBoundary(t *testing.T) {
	keys := [][]byte{
		[]byte("bar"),
		[]byte("barbell"),
		[]byte("bark"),
		[]byte("foo"),
		[]byte("foobar"),
		[]byte("qux"),
	}
	vals := make([][]byte, len(keys))
	for i := range vals {
		vals[i] = []byte(fmt.Sprintf("val-%d", i))
	}
	restarts := []int{0, 3, 5}
	entries := compress(keys, vals, restarts)

	if got := decompress(t, entries); !equalKeySets(got, keys) {
		t.Fatalf("reference mismatch: %v", got)
	}

	p, err := Open(newMemReader(entries), len(entries), restarts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// A target equal to each restart key must land exactly on that restart.
	// The chain starts at the preceding restart (strictly smaller key) or at
	// entry 0 for the first restart, then walks every entry up to the hit.
	for _, r := range restarts {
		res, ok, err := p.LowerBound(keys[r])
		if err != nil || !ok {
			t.Fatalf("restart %d LowerBound: ok=%v err=%v", r, ok, err)
		}
		if res.Index != r {
			t.Fatalf("restart boundary %d resolved to %d", r, res.Index)
		}
		wantStart := 0
		for _, earlier := range restarts {
			if earlier < r {
				wantStart = earlier
			}
		}
		if res.RebuildChain[0] != wantStart {
			t.Fatalf("restart %d chain %v must start at %d", r, res.RebuildChain, wantStart)
		}
		if res.RebuildChain[len(res.RebuildChain)-1] != r {
			t.Fatalf("restart %d chain %v must end at itself", r, res.RebuildChain)
		}
		if len(res.RebuildChain) != r-wantStart+1 {
			t.Fatalf("restart %d chain %v must walk every entry from %d", r, res.RebuildChain, wantStart)
		}
	}

	// Targets just before each key: result must match sort.Search semantics,
	// and the chain must begin at the nearest restart at or before the hit.
	for i := range keys {
		target := prefixBefore(keys[i])
		res, ok, err := p.LowerBound(target)
		if err != nil {
			t.Fatalf("LowerBound(%x): %v", target, err)
		}
		want := sort.Search(len(keys), func(j int) bool {
			return bytes.Compare(keys[j], target) >= 0
		})
		if want == len(keys) {
			if ok {
				t.Fatalf("target %x: unexpected hit %d", target, res.Index)
			}
			continue
		}
		if !ok || res.Index != want {
			t.Fatalf("target %x: got index %v ok=%v, want %d", target, res, ok, want)
		}
		// Expected restart: largest restart whose key is strictly smaller than
		// target; entry 0 when none qualifies (including no-restart pages).
		nearest := 0
		if k := sort.Search(len(restarts), func(j int) bool {
			return bytes.Compare(keys[restarts[j]], target) >= 0
		}); k > 0 {
			nearest = restarts[k-1]
		}
		if res.RebuildChain[0] != nearest {
			t.Fatalf("target %x: chain %v must begin at restart %d", target, res.RebuildChain, nearest)
		}
		if res.RebuildChain[len(res.RebuildChain)-1] != want {
			t.Fatalf("target %x: chain %v must end at hit %d", target, res.RebuildChain, want)
		}
	}
}

// randomPage builds a strictly ordered set of byte keys with random restart
// points, including an all-restart page and pages without restarts.
func randomPage(t *testing.T, rng *rand.Rand, n int) ([][]byte, [][]byte, []int, []Entry) {
	t.Helper()
	keys := make([][]byte, n)
	prev := []byte{}
	for i := 0; i < n; i++ {
		key := append(append([]byte(nil), prev...), byte(rng.Intn(256)))
		for bytes.Equal(key, prev) || (i > 0 && bytes.Compare(key, prev) <= 0) {
			key = append(key, byte(rng.Intn(256)))
		}
		keys[i] = key
		prev = key
	}
	vals := make([][]byte, n)
	for i := range vals {
		v := make([]byte, rng.Intn(8))
		rng.Read(v)
		vals[i] = v
	}

	var restarts []int
	switch rng.Intn(3) {
	case 0:
		// Every entry is a restart.
		for i := 0; i < n; i++ {
			restarts = append(restarts, i)
		}
	case 1:
		// Sparse random restarts, always including 0 for non-empty pages.
		if n > 0 {
			restarts = append(restarts, 0)
			for i := 1; i < n; i++ {
				if rng.Intn(3) == 0 {
					restarts = append(restarts, i)
				}
			}
		}
	default:
		// No restart points at all.
	}
	entries := compress(keys, vals, restarts)
	return keys, vals, restarts, entries
}

func TestRandomizedReferenceAndLowerBound(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 200; iter++ {
		n := rng.Intn(40)
		keys, vals, restarts, entries := randomPage(t, rng, n)

		// Full-decompression reference check on every generated page.
		if got := decompress(t, entries); !equalKeySets(got, keys) {
			t.Fatalf("iter %d: reference mismatch", iter)
		}

		reader := newMemReader(entries)
		p, err := Open(reader, n, restarts)
		if err != nil {
			t.Fatalf("iter %d: Open: %v", iter, err)
		}
		if len(p.VerifyAccess()) != n {
			t.Fatalf("iter %d: verify touched %d entries, want %d", iter, len(p.VerifyAccess()), n)
		}

		probeCount := 30
		if n == 0 {
			probeCount = 5
		}
		for q := 0; q < probeCount; q++ {
			var target []byte
			switch rng.Intn(3) {
			case 0:
				target = []byte{}
			case 1:
				if n > 0 {
					target = append([]byte(nil), keys[rng.Intn(n)]...)
				}
			default:
				target = make([]byte, rng.Intn(10))
				rng.Read(target)
			}

			res, ok, err := p.LowerBound(target)
			if err != nil {
				t.Fatalf("iter %d query %d: %v", iter, q, err)
			}
			want := sort.Search(n, func(j int) bool {
				return bytes.Compare(keys[j], target) >= 0
			})
			if want == n {
				if ok {
					t.Fatalf("iter %d: target %x unexpectedly hit %d", iter, target, res.Index)
				}
				continue
			}
			if !ok || res.Index != want {
				t.Fatalf("iter %d target %x: got %v ok=%v, want index %d", iter, target, res, ok, want)
			}
			if !bytes.Equal(res.Key, keys[want]) || !bytes.Equal(res.Value, vals[want]) {
				t.Fatalf("iter %d: payload mismatch at %d", iter, want)
			}
			// Chain starts at the largest restart whose key is strictly
			// smaller than target (reference binary search over restart keys).
			nearest := 0
			if k := sort.Search(len(restarts), func(j int) bool {
				return bytes.Compare(keys[restarts[j]], target) >= 0
			}); k > 0 {
				nearest = restarts[k-1]
			}
			if res.RebuildChain[0] != nearest {
				t.Fatalf("iter %d: chain %v starts at %d, want restart %d",
					iter, res.RebuildChain, res.RebuildChain[0], nearest)
			}
			if res.RebuildChain[len(res.RebuildChain)-1] != want {
				t.Fatalf("iter %d: chain ends at %d, want hit %d",
					iter, res.RebuildChain[len(res.RebuildChain)-1], want)
			}
			prevIdx := -1
			for _, idx := range res.RebuildChain {
				if idx < 0 || idx >= n {
					t.Fatalf("iter %d: chain index %d outside [0,%d)", iter, idx, n)
				}
				if idx <= prevIdx {
					t.Fatalf("iter %d: non-monotonic chain %v", iter, res.RebuildChain)
				}
				prevIdx = idx
			}
			if want-nearest+1 != len(res.RebuildChain) {
				t.Fatalf("iter %d: chain %v length %d, want %d entries from restart %d",
					iter, res.RebuildChain, len(res.RebuildChain), want-nearest+1, nearest)
			}
		}

		if reader.badReads() != 0 {
			t.Fatalf("iter %d: %d out-of-range reader calls", iter, reader.badReads())
		}
	}
}

func TestConcurrentQueriesAndTraces(t *testing.T) {
	keys := [][]byte{
		[]byte("k00"), []byte("k01"), []byte("k02"), []byte("k03"),
		[]byte("k10"), []byte("k11"), []byte("k12"), []byte("k13"),
	}
	vals := make([][]byte, len(keys))
	for i := range vals {
		vals[i] = []byte(fmt.Sprintf("v%d", i))
	}
	restarts := []int{0, 4}
	entries := compress(keys, vals, restarts)

	reader := newMemReader(entries)
	p, err := Open(reader, len(entries), restarts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	const goroutines = 64
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for g := 0; g < goroutines; g++ {
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(seed)))
			for round := 0; round < 50; round++ {
				target := keys[rng.Intn(len(keys))]
				res, ok, qerr := p.LowerBound(target)
				if qerr != nil || !ok {
					t.Errorf("query target %q: ok=%v err=%v", target, ok, qerr)
					return
				}
				if !bytes.Equal(res.Key, target) {
					t.Errorf("key mismatch: got %q want %q", res.Key, target)
				}
			}
		}(g)
	}
	wg.Wait()

	if reader.badReads() != 0 {
		t.Fatalf("concurrent queries caused %d out-of-range calls", reader.badReads())
	}
	// Every recorded query access is in range.
	for _, idx := range p.QueryAccess() {
		if idx < 0 || idx >= p.Count() {
			t.Fatalf("query trace contains out-of-range index %d", idx)
		}
	}
	// Verify trace stays untouched by query traffic.
	if len(p.VerifyAccess()) != len(keys) {
		t.Fatal("verify trace altered by concurrent queries")
	}
}

func TestReturnedBytesArePrivateCopies(t *testing.T) {
	keys := [][]byte{[]byte("alpha"), []byte("beta")}
	vals := [][]byte{[]byte("one"), []byte("two")}
	entries := compress(keys, vals, []int{0, 1})
	p, err := Open(newMemReader(entries), 2, []int{0, 1})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	first, ok, err := p.LowerBound([]byte("a"))
	if err != nil || !ok {
		t.Fatalf("LowerBound: ok=%v err=%v", ok, err)
	}
	for i := range first.Key {
		first.Key[i] = 'X'
	}
	for i := range first.Value {
		first.Value[i] = 'Y'
	}

	again, ok, err := p.LowerBound([]byte("a"))
	if err != nil || !ok {
		t.Fatalf("second LowerBound: ok=%v err=%v", ok, err)
	}
	if !bytes.Equal(again.Key, keys[0]) || !bytes.Equal(again.Value, vals[0]) {
		t.Fatalf("cache exposed mutable bytes: got %q/%q, want %q/%q",
			again.Key, again.Value, keys[0], vals[0])
	}

	// Restart and accessor copies are independent of caller slices.
	restarts := p.RestartPoints()
	restarts[0] = 999
	if p.RestartPoints()[0] != 0 {
		t.Fatal("RestartPoints returned shared backing array")
	}
	trace := p.VerifyAccess()
	trace[0] = 999
	if p.VerifyAccess()[0] != 0 {
		t.Fatal("VerifyAccess returned shared backing array")
	}
}

type failingReader struct {
	failAt int
}

func (f failingReader) ReadEntry(index int) (Entry, error) {
	if index == f.failAt {
		return Entry{}, errors.New("injected read failure")
	}
	return Entry{Shared: 0, Suffix: []byte(fmt.Sprintf("key-%d", index))}, nil
}

func TestReaderErrorsPropagate(t *testing.T) {
	// Failure during whole-page verification.
	if _, err := Open(failingReader{failAt: 2}, 4, []int{0}); err == nil {
		t.Fatal("Open must surface reader errors")
	}

	// Failure during the linear rebuild phase of a query.
	good := []Entry{
		{Shared: 0, Suffix: []byte("k0")},
		{Shared: 1, Suffix: []byte("1")},
		{Shared: 1, Suffix: []byte("2")},
		{Shared: 1, Suffix: []byte("3")},
	}
	reader := &flakyReader{entries: good, failAt: 3}
	p, err := Open(reader, 4, []int{0})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok, err := p.LowerBound([]byte("k3")); err == nil || ok {
		t.Fatalf("query must surface rebuild read error, got ok=%v err=%v", ok, err)
	}
}

type flakyReader struct {
	mu      sync.Mutex
	entries []Entry
	failAt  int
	calls   int
}

func (f *flakyReader) ReadEntry(index int) (Entry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	// Only fail after verification has completed, i.e. on query-phase reads.
	if f.calls > len(f.entries) && index == f.failAt {
		return Entry{}, errors.New("injected query failure")
	}
	e := f.entries[index]
	return Entry{Shared: e.Shared, Suffix: append([]byte(nil), e.Suffix...)}, nil
}

func TestPageWithoutRestartPoints(t *testing.T) {
	keys := [][]byte{[]byte("cat"), []byte("cater"), []byte("cattle")}
	vals := [][]byte{[]byte("0"), []byte("1"), []byte("2")}
	entries := compress(keys, vals, nil)
	if entries[1].Shared != 3 || entries[2].Shared != 3 {
		t.Fatalf("compression helper produced wrong prefixes: %+v", entries)
	}
	if got := decompress(t, entries); !equalKeySets(got, keys) {
		t.Fatalf("reference mismatch: %v", got)
	}

	reader := newMemReader(entries)
	p, err := Open(reader, 3, nil)
	if err != nil {
		t.Fatalf("Open without restarts: %v", err)
	}

	// Every query rebuilds from entry 0 because no restart exists.
	res, ok, err := p.LowerBound([]byte("cattle"))
	if err != nil || !ok {
		t.Fatalf("LowerBound: ok=%v err=%v", ok, err)
	}
	if res.Index != 2 || !intsEqual(res.RebuildChain, []int{0, 1, 2}) {
		t.Fatalf("no-restart chain = %d/%v, want index 2 chain [0 1 2]", res.Index, res.RebuildChain)
	}
	if !intsEqual(p.QueryAccess(), []int{0, 1, 2}) {
		t.Fatalf("query access = %v, want rebuild chain entries", p.QueryAccess())
	}
	if reader.badReads() != 0 {
		t.Fatalf("out-of-range reads: %d", reader.badReads())
	}
}

func TestKeyAtAndAccessTraceSeparation(t *testing.T) {
	keys := [][]byte{[]byte("aa"), []byte("ab"), []byte("ba"), []byte("bb")}
	vals := [][]byte{nil, nil, nil, nil}
	restarts := []int{0, 2}
	entries := compress(keys, vals, restarts)
	p, err := Open(newMemReader(entries), 4, restarts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	for i, want := range keys {
		got, err := p.KeyAt(i)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("KeyAt(%d) = %x err=%v, want %x", i, got, err, want)
		}
		got[0] = 0
		again, err := p.KeyAt(i)
		if err != nil || !bytes.Equal(again, want) {
			t.Fatalf("KeyAt exposed mutable cache: %x", again)
		}
	}
	if _, err := p.KeyAt(-1); !errors.Is(err, ErrIndexOutOfRange) {
		t.Fatalf("KeyAt(-1) err = %v, want ErrIndexOutOfRange", err)
	}
	if _, err := p.KeyAt(4); !errors.Is(err, ErrIndexOutOfRange) {
		t.Fatalf("KeyAt(4) err = %v, want ErrIndexOutOfRange", err)
	}

	// A query that probes restart index 2 then rebuilds from restart 0:
	// target "aa" equals restart 0, so no restart key is strictly smaller.
	res, ok, err := p.LowerBound([]byte("aa"))
	if err != nil || !ok {
		t.Fatalf("LowerBound: ok=%v err=%v", ok, err)
	}
	if !intsEqual(res.RebuildChain, []int{0}) {
		t.Fatalf("rebuild chain = %v, want [0]", res.RebuildChain)
	}

	// Probes live only in the query log, never in the verify trace.
	queryLog := p.QueryAccess()
	if len(queryLog) == 0 {
		t.Fatal("expected restart probes in query access log")
	}
	for _, idx := range queryLog {
		if idx < 0 || idx >= p.Count() {
			t.Fatalf("query log index %d outside page", idx)
		}
	}
	if !intsEqual(p.VerifyAccess(), []int{0, 1, 2, 3}) {
		t.Fatalf("verify trace contaminated: %v", p.VerifyAccess())
	}
}
