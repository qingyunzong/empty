package formal

import (
	"sort"
	"strings"
)

// CacheEntry is a cached answer. The zero value is a positive (NOERROR)
// answer. A NameError rcode represents a cached negative answer.
type CacheEntry struct {
	Rcode  Rcode
	Values []string
}

// Cache is consulted before every forwarding attempt. A hit must not cause any
// forwarder exchange. Lookup receives a canonical, lowercase FQDN with a
// trailing root dot.
type Cache interface {
	Lookup(name string) (CacheEntry, bool)
}

// CacheFunc adapts a function to the Cache interface.
type CacheFunc func(name string) (CacheEntry, bool)

// Lookup implements Cache.
func (f CacheFunc) Lookup(name string) (CacheEntry, bool) { return f(name) }

// MapCache is a convenient in-memory cache. Keys are compared case-insensitively
// and ignore one trailing dot. If more than one key canonicalizes to the same
// name, the lexicographically first key wins deterministically.
type MapCache map[string]CacheEntry

// Lookup implements Cache.
func (c MapCache) Lookup(name string) (CacheEntry, bool) {
	if entry, ok := c[name]; ok {
		return entry, true
	}

	target := cacheKey(name)
	keys := make([]string, 0, len(c))
	for key := range c {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if cacheKey(key) == target {
			return c[key], true
		}
	}
	return CacheEntry{}, false
}

func cacheKey(name string) string {
	return strings.ToLower(strings.TrimSuffix(name, "."))
}
