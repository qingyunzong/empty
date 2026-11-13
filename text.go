package dataeng

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func runeLen(s string) int {
	return utf8.RuneCountInString(s)
}

func isIgnorableRune(r rune) bool {
	switch r {
	case '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff':
		return true
	}
	return unicode.IsSpace(r)
}

// compactText removes whitespace and zero-width characters while retaining a
// mapping from each surviving byte-independent rune to its original rune
// offset. This is used for split/merge detection: crawlers frequently preserve
// a space at one side of a paragraph boundary, or no space at all for CJK text.
func compactText(s string) (string, []int) {
	var b strings.Builder
	b.Grow(len(s))
	origins := make([]int, 0, len(s))
	runeIndex := 0
	for _, r := range s {
		if !isIgnorableRune(r) {
			b.WriteRune(r)
			origins = append(origins, runeIndex)
		}
		runeIndex++
	}
	return b.String(), origins
}

func squashText(s string) string {
	out, _ := compactText(s)
	return out
}

func collapseWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// textSimilarity returns a rune-based similarity in [0,1]. Long paragraphs use
// a bigram overlap estimate to keep the diff bounded for pathological input.
func textSimilarity(a, b string) float64 {
	ar, br := []rune(a), []rune(b)
	if len(ar) == 0 && len(br) == 0 {
		return 1
	}
	if len(ar) == 0 || len(br) == 0 {
		return 0
	}
	maxLen := len(ar)
	if len(br) > maxLen {
		maxLen = len(br)
	}
	if maxLen > 4000 {
		return bigramSimilarity(ar, br)
	}
	dist := levenshtein(ar, br)
	return 1 - float64(dist)/float64(maxLen)
}

func levenshtein(a, b []rune) int {
	if len(a) > len(b) {
		a, b = b, a
	}
	prev := make([]int, len(a)+1)
	curr := make([]int, len(a)+1)
	for i := range prev {
		prev[i] = i
	}
	for j := 1; j <= len(b); j++ {
		curr[0] = j
		for i := 1; i <= len(a); i++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curr[i] = min3(curr[i-1]+1, prev[i]+1, prev[i-1]+cost)
		}
		prev, curr = curr, prev
	}
	return prev[len(a)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

func bigramSimilarity(a, b []rune) float64 {
	if len(a) < 2 || len(b) < 2 {
		return textPrefixSuffixSimilarity(a, b)
	}
	counts := make(map[[2]rune]int, len(a))
	for i := 0; i < len(a)-1; i++ {
		counts[[2]rune{a[i], a[i+1]}]++
	}
	common := 0
	for i := 0; i < len(b)-1; i++ {
		key := [2]rune{b[i], b[i+1]}
		if counts[key] > 0 {
			common++
			counts[key]--
		}
	}
	return 2 * float64(common) / float64(len(a)+len(b)-2)
}

func textPrefixSuffixSimilarity(a, b []rune) float64 {
	maxLen := len(a)
	if len(b) > maxLen {
		maxLen = len(b)
	}
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix &&
		a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	return float64(prefix+suffix) / float64(maxLen)
}

// sourceFragment maps the compact range [start,end) of a source string back to
// block-local rune offsets and, when available, document offsets.
func sourceFragment(block Block, blockID string, compactOrigins []int, start, end int) SourceFragment {
	runes := runeLen(block.Text)
	localStart, localEnd := 0, runes
	if len(compactOrigins) > 0 {
		switch {
		case start <= 0:
			localStart = 0
		case start < len(compactOrigins):
			localStart = compactOrigins[start]
		default:
			localStart = runes
		}
		switch {
		case end <= start:
			localEnd = localStart
		case end <= len(compactOrigins):
			localEnd = compactOrigins[end-1] + 1
		default:
			localEnd = runes
		}
	}
	frag := SourceFragment{BlockID: blockID, Start: localStart, End: localEnd}
	if block.Range.Valid() {
		frag.Document = TextSpan{
			Start: block.Range.Start + localStart,
			End:   block.Range.Start + localEnd,
		}
	}
	return frag
}

func shortHash(s string) string {
	const width = 8
	var h uint64 = 1469598103934665603
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= 1099511628211
	}
	const hexDigits = "0123456789abcdef"
	buf := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		buf[i] = hexDigits[h&0xf]
		h >>= 4
	}
	return string(buf)
}
