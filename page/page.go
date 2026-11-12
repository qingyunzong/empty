// Package page reads prefix-compressed key/value data pages and answers
// lower_bound lookups by rebuilding entries from the nearest restart point.
//
// An entry stores a shared-prefix length, a key suffix and a value. The
// caller is responsible for parsing the on-disk layout (lengths and restart
// indices); the package only consumes entries one at a time through the
// injected [Reader]. A whole page is rejected when an entry prefix is
// invalid, two keys are not strictly increasing in raw byte order, or a
// restart index points outside the page.
package page

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
)

var (
	// ErrIndexOutOfRange reports a caller-supplied index that is not an entry
	// index of the page, including negative indices.
	ErrIndexOutOfRange = errors.New("page: index out of range")

	// ErrRestartOutOfRange reports a restart index that is not an entry index
	// of the page, including negative indices.
	ErrRestartOutOfRange = errors.New("page: restart index out of range")

	// ErrInvalidPrefix reports an entry whose shared-prefix length is negative
	// or longer than the preceding key, or a restart entry whose prefix is not
	// zero.
	ErrInvalidPrefix = errors.New("page: invalid shared prefix length")

	// ErrDuplicateKey reports adjacent keys that are not strictly increasing in
	// raw byte order.
	ErrDuplicateKey = errors.New("page: duplicate or out-of-order key")

	// ErrEmptyPageRestarts reports restart indices attached to an empty page.
	ErrEmptyPageRestarts = errors.New("page: empty page must have no restart points")
)

// Entry is one compressed record as parsed by the caller.
//
// Shared is the number of leading key bytes inherited from the previous
// entry; the entry's full key is the first Shared bytes of the previous key
// followed by Suffix. Values never participate in prefix compression.
type Entry struct {
	Shared int
	Suffix []byte
	Value  []byte
}

// Reader is the caller-injected, per-entry access interface. Implementations
// must be safe for concurrent use because [Page.LowerBound] may run in
// parallel. ReadEntry must return an error when index is outside [0,count);
// the package never invokes it with such an index itself, and the error is
// surfaced to the caller instead of being swallowed.
type Reader interface {
	ReadEntry(index int) (Entry, error)
}

// Page is a validated compressed page. Its cached keys are owned by the
// Page: [Page.LowerBound] returns copies, so mutating returned keys cannot
// corrupt the cache. A Page is safe for concurrent queries.
type Page struct {
	reader Reader
	count  int

	// restart entry indices, strictly increasing and all within [0,count).
	restarts []int

	// full key of every entry, materialized once during verification.
	keys [][]byte

	// verifyAccess records every entry index touched while validating the
	// whole page; queryAccess records accesses made by LowerBound calls.
	verifyAccess []int

	mu          sync.Mutex
	queryAccess []int
}

// Open validates the whole page by fully decompressing it through reader and
// returns the ready Page. count is the number of entries and restarts the
// caller-parsed restart indices; both are consumed defensively and may be
// reused by the caller afterwards.
func Open(reader Reader, count int, restarts []int) (*Page, error) {
	if reader == nil {
		return nil, errors.New("page: nil reader")
	}
	if count < 0 {
		return nil, fmt.Errorf("page: negative entry count %d", count)
	}
	if count == 0 && len(restarts) != 0 {
		return nil, ErrEmptyPageRestarts
	}

	restartSet := make(map[int]struct{}, len(restarts))
	for i, r := range restarts {
		if r < 0 || r >= count {
			return nil, fmt.Errorf("%w: restart[%d]=%d for count=%d",
				ErrRestartOutOfRange, i, r, count)
		}
		if _, seen := restartSet[r]; seen {
			return nil, fmt.Errorf("%w: duplicate restart %d", ErrRestartOutOfRange, r)
		}
		restartSet[r] = struct{}{}
	}

	p := &Page{
		reader:   reader,
		count:    count,
		restarts: append([]int(nil), restarts...),
		keys:     make([][]byte, count),
	}

	var prev []byte
	for i := 0; i < count; i++ {
		entry, err := reader.ReadEntry(i)
		p.verifyAccess = append(p.verifyAccess, i)
		if err != nil {
			return nil, fmt.Errorf("page: read entry %d: %w", i, err)
		}

		if entry.Shared < 0 || entry.Shared > len(prev) {
			return nil, fmt.Errorf("%w: entry %d shares %d bytes of a %d-byte key",
				ErrInvalidPrefix, i, entry.Shared, len(prev))
		}
		if _, isRestart := restartSet[i]; isRestart && entry.Shared != 0 {
			return nil, fmt.Errorf("%w: restart entry %d has shared length %d",
				ErrInvalidPrefix, i, entry.Shared)
		}

		key := make([]byte, 0, entry.Shared+len(entry.Suffix))
		key = append(key, prev[:entry.Shared]...)
		key = append(key, entry.Suffix...)

		if prev != nil && bytes.Compare(key, prev) <= 0 {
			return nil, fmt.Errorf("%w: entry %d", ErrDuplicateKey, i)
		}

		p.keys[i] = key
		prev = key
	}

	return p, nil
}

// Count returns the number of entries in the page.
func (p *Page) Count() int { return p.count }

// RestartPoints returns a copy of the restart entry indices.
func (p *Page) RestartPoints() []int {
	return append([]int(nil), p.restarts...)
}

// KeyAt returns a private copy of the verified full key at index.
func (p *Page) KeyAt(index int) ([]byte, error) {
	if index < 0 || index >= p.count {
		return nil, fmt.Errorf("%w: key index %d for count=%d",
			ErrIndexOutOfRange, index, p.count)
	}
	return append([]byte(nil), p.keys[index]...), nil
}

// VerifyAccess returns a copy of the entry indices visited while the whole
// page was validated, in visit order.
func (p *Page) VerifyAccess() []int {
	return append([]int(nil), p.verifyAccess...)
}

// QueryAccess returns a copy of every entry index visited by LowerBound
// queries so far, in chronological visit order. It is recorded separately
// from [Page.VerifyAccess] and is safe to read concurrently with queries.
func (p *Page) QueryAccess() []int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]int(nil), p.queryAccess...)
}

// Result is a successful lower_bound hit.
type Result struct {
	// Index is the page-local index of the located entry.
	Index int

	// Key and Value are owned copies: mutating them never affects the Page
	// cache or other query results.
	Key   []byte
	Value []byte

	// RebuildChain lists, in order, the entries rebuilt from the selected
	// restart point up to and including Index; it is always strictly
	// increasing. Restart probes made during binary search are recorded
	// separately via [Page.QueryAccess].
	RebuildChain []int
}

// LowerBound returns the first entry whose key is greater than or equal to
// target in raw byte order. The boolean result is false (with a nil Result)
// when no such entry exists, including for an empty page.
//
// The entry is rebuilt starting at the nearest restart point whose key is
// strictly smaller than target. All entry accesses go through the injected
// [Reader]; no index outside [0,Count) is ever requested.
func (p *Page) LowerBound(target []byte) (*Result, bool, error) {
	if p.count == 0 {
		return nil, false, nil
	}

	start, err := p.locateRestart(target)
	if err != nil {
		return nil, false, err
	}

	chain := make([]int, 0)

	var currentKey []byte
	for i := start; i < p.count; i++ {
		entry, err := p.reader.ReadEntry(i)
		p.recordAccess(i)
		chain = append(chain, i)
		if err != nil {
			return nil, false, fmt.Errorf("page: read entry %d: %w", i, err)
		}

		if entry.Shared < 0 || entry.Shared > len(currentKey) {
			return nil, false, fmt.Errorf("%w: entry %d shares %d bytes of a %d-byte key",
				ErrInvalidPrefix, i, entry.Shared, len(currentKey))
		}
		rebuilt := make([]byte, 0, entry.Shared+len(entry.Suffix))
		rebuilt = append(rebuilt, currentKey[:entry.Shared]...)
		rebuilt = append(rebuilt, entry.Suffix...)
		currentKey = rebuilt

		if bytes.Compare(currentKey, target) >= 0 {
			valueCopy := append([]byte(nil), entry.Value...)
			return &Result{
				Index:        i,
				Key:          append([]byte(nil), currentKey...),
				Value:        valueCopy,
				RebuildChain: append([]int(nil), chain...),
			}, true, nil
		}
	}

	return nil, false, nil
}

// locateRestart binary-searches restart points through the injected reader
// and returns the largest restart index whose key is strictly smaller than
// target, or 0 when no such restart exists (including a page without restart
// points). Restart entries carry no shared prefix, so their suffix is their
// full key. Every probed entry is read through the injected reader and
// recorded in the query-access log, but probes are not part of the linear
// rebuild chain reported in [Result].
func (p *Page) locateRestart(target []byte) (int, error) {
	lo, hi := 0, len(p.restarts)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		idx := p.restarts[mid]
		if idx < 0 || idx >= p.count {
			// Defensive only: Open guarantees this cannot happen.
			return 0, fmt.Errorf("%w: restart %d for count=%d",
				ErrRestartOutOfRange, idx, p.count)
		}
		entry, err := p.reader.ReadEntry(idx)
		p.recordAccess(idx)
		if err != nil {
			return 0, fmt.Errorf("page: read restart entry %d: %w", idx, err)
		}
		if entry.Shared != 0 {
			return 0, fmt.Errorf("%w: restart entry %d has shared length %d",
				ErrInvalidPrefix, idx, entry.Shared)
		}
		if bytes.Compare(entry.Suffix, target) < 0 {
			lo = mid + 1
		} else {
			hi = mid
		}
	}

	if lo == 0 {
		return 0, nil
	}
	return p.restarts[lo-1], nil
}

func (p *Page) recordAccess(index int) {
	p.mu.Lock()
	p.queryAccess = append(p.queryAccess, index)
	p.mu.Unlock()
}
