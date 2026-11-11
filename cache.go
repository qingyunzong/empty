package q149

import (
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	// ErrLengthMismatch is returned when the consumed body length differs from
	// the declared Content-Length. A mismatching entry is never published.
	ErrLengthMismatch = errors.New("q149: response body length does not match Content-Length")

	// ErrEntryGone is returned when a stale entry used for a conditional
	// request is no longer present in the cache.
	ErrEntryGone = errors.New("q149: cache entry no longer exists")
)

// Entry is an immutable, published cache record.
type Entry struct {
	id       uint64
	url      string
	status   int
	header   http.Header
	body     []byte
	vary     []string
	selector map[string]string
	storedAt time.Time
}

// ID uniquely identifies the stored variant within its Cache.
func (e *Entry) ID() uint64 { return e.id }

// URL is the request URL the entry was stored for.
func (e *Entry) URL() string { return e.url }

// StatusCode is the status line carried by the stored response.
func (e *Entry) StatusCode() int { return e.status }

// Header returns the stored response headers. The caller must not mutate them.
func (e *Entry) Header() http.Header { return e.header }

// Body returns the fully consumed, length-verified response body.
func (e *Entry) Body() []byte { return e.body }

// Vary returns the normalized header field names listed by the Vary header.
func (e *Entry) Vary() []string { return e.vary }

// StoredAt returns the clock time at which the entry became visible.
func (e *Entry) StoredAt() time.Time { return e.storedAt }

// Cache is a concurrency-safe, in-process HTTP response cache.
//
// Records are keyed by request URL plus the request header values selected by
// the response Vary header. A record becomes visible atomically, only after
// its body has been fully consumed and its Content-Length verified.
type Cache struct {
	clock Clock

	mu     sync.RWMutex
	byURL  map[string]map[uint64]*Entry
	byID   map[uint64]*Entry
	nextID uint64
}

// NewCache constructs an empty Cache driven by clock.
// A nil clock is replaced with SystemClock.
func NewCache(clock Clock) *Cache {
	if clock == nil {
		clock = SystemClock{}
	}
	return &Cache{
		clock: clock,
		byURL: make(map[string]map[uint64]*Entry),
		byID:  make(map[uint64]*Entry),
	}
}

// Cacheable reports whether a response may be persisted: directives
// Cache-Control: no-store and Vary: * forbid storage unconditionally.
func Cacheable(header http.Header) bool {
	for _, directive := range parseCacheControl(header.Get("Cache-Control")) {
		if directive == "no-store" {
			return false
		}
	}
	for _, v := range header.Values("Vary") {
		if strings.TrimSpace(v) == "*" {
			return false
		}
	}
	return true
}

// Store consumes body on behalf of the caller. The body is always closed,
// including on failure or interruption.
//
// The returned entry is nil with no error when the response is not cacheable.
// The entry becomes visible to concurrent Lookup callers atomically, and only
// after the whole body was read and its declared length was verified. A body
// read error or length mismatch aborts publication and is returned to the
// caller; no partial content is ever published.
func (c *Cache) Store(req *http.Request, header http.Header, body io.ReadCloser) (*Entry, error) {
	if req == nil || req.URL == nil {
		return nil, errors.New("q149: Store requires a non-nil request URL")
	}
	if body == nil {
		return nil, errors.New("q149: Store requires a non-nil body ReadCloser")
	}
	defer body.Close()

	if !Cacheable(header) {
		if _, err := io.Copy(io.Discard, body); err != nil {
			return nil, err
		}
		return nil, nil
	}

	data, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	if declared := header.Get("Content-Length"); declared != "" {
		want, convErr := strconv.Atoi(declared)
		if convErr == nil && want != len(data) {
			return nil, ErrLengthMismatch
		}
	}

	vary := parseVary(header.Values("Vary"))
	selector := make(map[string]string, len(vary))
	for _, name := range vary {
		selector[name] = req.Header.Get(name)
	}

	entry := &Entry{
		url:      req.URL.String(),
		status:   http.StatusOK,
		header:   cloneHeader(header),
		body:     data,
		vary:     vary,
		selector: selector,
		storedAt: c.clock.Now(),
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	variants := c.byURL[entry.url]
	if variants == nil {
		variants = make(map[uint64]*Entry)
		c.byURL[entry.url] = variants
	}

	var id uint64
	for existingID, existing := range variants {
		if sameVariant(existing, entry) {
			id = existingID
			break
		}
	}
	if id == 0 {
		c.nextID++
		id = c.nextID
		entry.id = id
	} else {
		entry.id = id
	}

	variants[id] = entry
	c.byID[id] = entry
	return entry, nil
}

// Lookup returns the stored variant whose Vary selector matches req, or nil.
func (c *Cache) Lookup(req *http.Request) *Entry {
	if req == nil || req.URL == nil {
		return nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()

	for _, entry := range c.byURL[req.URL.String()] {
		if variantMatches(entry, req.Header) {
			return entry
		}
	}
	return nil
}

// Revalidate refreshes the exact variant identified by stale (the record the
// caller used to build the conditional request) with a 304 response.
//
// The stale entry must still be the record addressed by its ID. A newer
// response committed for the same URL and variant first is never overwritten:
// it replaces the old ID, so a late 304 is rejected with ErrEntryGone instead
// of clobbering the newer content.
func (c *Cache) Revalidate(stale *Entry, notModifiedHeader http.Header) (*Entry, error) {
	if stale == nil {
		return nil, errors.New("q149: Revalidate requires a non-nil stale entry")
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	current, ok := c.byID[stale.id]
	if !ok || current != stale {
		return nil, ErrEntryGone
	}

	refreshed := &Entry{
		id:       stale.id,
		url:      stale.url,
		status:   stale.status,
		header:   mergeNotModified(stale.header, notModifiedHeader),
		body:     stale.body,
		vary:     stale.vary,
		selector: stale.selector,
		storedAt: c.clock.Now(),
	}
	c.byID[stale.id] = refreshed
	c.byURL[stale.url][stale.id] = refreshed
	return refreshed, nil
}

// Entries returns a snapshot of all currently published entries.
func (c *Cache) Entries() []*Entry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]*Entry, 0, len(c.byID))
	for _, entry := range c.byID {
		out = append(out, entry)
	}
	return out
}

// Fresh reports whether entry is still fresh at the cache clock, using the
// Cache-Control: max-age directive (or 0 when absent).
func (c *Cache) Fresh(entry *Entry) bool {
	maxAge := maxAgeSeconds(entry.header.Get("Cache-Control"))
	return c.clock.Now().Sub(entry.storedAt) < time.Duration(maxAge)*time.Second
}

func sameVariant(a, b *Entry) bool {
	if len(a.vary) != len(b.vary) {
		return false
	}
	for i := range a.vary {
		if a.vary[i] != b.vary[i] {
			return false
		}
	}
	if len(a.selector) != len(b.selector) {
		return false
	}
	for name, value := range a.selector {
		if b.selector[name] != value {
			return false
		}
	}
	return true
}

func variantMatches(entry *Entry, requestHeader http.Header) bool {
	for _, name := range entry.vary {
		if entry.selector[name] != requestHeader.Get(name) {
			return false
		}
	}
	return true
}

// mergeNotModified applies a 304 to the stored headers per RFC 7234 4.3.4:
// hop-by-hop and framing headers from the 304 are dropped, all other
// first-party headers replace or extend the stored ones.
func mergeNotModified(stored, notModified http.Header) http.Header {
	merged := cloneHeader(stored)
	for name, values := range notModified {
		if hopByHop[name] || framingHeader[name] {
			continue
		}
		merged[http.CanonicalHeaderKey(name)] = append([]string(nil), values...)
	}
	return merged
}

var hopByHop = map[string]bool{
	"Connection":          true,
	"Proxy-Connection":    true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

var framingHeader = map[string]bool{
	"Content-Length": true,
}

func parseCacheControl(value string) []string {
	var directives []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if idx := strings.IndexByte(part, '='); idx >= 0 {
			part = part[:idx]
		}
		directives = append(directives, strings.ToLower(strings.TrimSpace(part)))
	}
	return directives
}

func maxAgeSeconds(value string) int {
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if len(part) > 8 && strings.EqualFold(part[:8], "max-age=") {
			if n, err := strconv.Atoi(strings.TrimSpace(part[8:])); err == nil && n >= 0 {
				return n
			}
		}
	}
	return 0
}

func parseVary(values []string) []string {
	seen := make(map[string]bool)
	var names []string
	for _, value := range values {
		for _, field := range strings.Split(value, ",") {
			field = strings.TrimSpace(field)
			if field == "" {
				continue
			}
			canonical := http.CanonicalHeaderKey(field)
			if !seen[canonical] {
				seen[canonical] = true
				names = append(names, canonical)
			}
		}
	}
	sort.Strings(names)
	return names
}

func cloneHeader(h http.Header) http.Header {
	clone := make(http.Header, len(h))
	for name, values := range h {
		clone[name] = append([]string(nil), values...)
	}
	return clone
}
