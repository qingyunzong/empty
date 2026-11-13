package dataeng

import (
	"crypto/sha256"
	"encoding/binary"
	"sort"
	"strconv"
)

// contentHash fingerprints the full content of a span so that duplicate
// deliveries are deduplicated and conflicting redeliveries are detected.
func contentHash(s Span) [32]byte {
	h := sha256.New()
	h.Write(s.TraceID[:])
	h.Write(s.SpanID[:])
	h.Write(s.ParentSpanID[:])
	h.Write([]byte(s.Name))
	h.Write([]byte{0})
	h.Write([]byte(s.Kind))
	h.Write([]byte{0})
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(s.Start.UnixNano()))
	h.Write(buf[:])
	binary.BigEndian.PutUint64(buf[:], uint64(s.End.UnixNano()))
	h.Write(buf[:])
	writeAttrs(h, s.Attributes)
	writeLinks(h, s.Links)
	writeAttrs(h, s.Resource.Attributes)
	h.Write([]byte(s.Scope.Name))
	h.Write([]byte{0})
	h.Write([]byte(s.Scope.Version))
	h.Write([]byte{0})
	writeAttrs(h, s.Scope.Attributes)
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

func writeAttrs(h interface{ Write([]byte) (int, error) }, attrs map[string]string) {
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	binary.Write(h, binary.BigEndian, uint64(len(keys)))
	for _, k := range keys {
		h.Write([]byte(k))
		h.Write([]byte{0})
		h.Write([]byte(attrs[k]))
		h.Write([]byte{0})
	}
}

func writeLinks(h interface{ Write([]byte) (int, error) }, links []Link) {
	sorted := make([]Link, len(links))
	copy(sorted, links)
	sort.Slice(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.TraceID != b.TraceID {
			return string(a.TraceID[:]) < string(b.TraceID[:])
		}
		return string(a.SpanID[:]) < string(b.SpanID[:])
	})
	binary.Write(h, binary.BigEndian, uint64(len(sorted)))
	for _, l := range sorted {
		h.Write(l.TraceID[:])
		h.Write(l.SpanID[:])
		writeAttrs(h, l.Attributes)
	}
}

// hashString renders a hash for diagnostics.
func hashString(h [32]byte) string {
	return strconv.FormatUint(binary.BigEndian.Uint64(h[:8]), 16)
}
