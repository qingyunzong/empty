package segidx

import (
	"strings"
	"unicode"
)

// Tokenize splits text into lowercase alphanumeric tokens. A token's index in
// the returned slice is its position, which phrase queries rely on.
func Tokenize(text string) []string {
	var tokens []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, cur.String())
			cur.Reset()
		}
	}
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			cur.WriteRune(unicode.ToLower(r))
		} else {
			flush()
		}
	}
	flush()
	return tokens
}

// NormTerm normalizes a single query term the same way Tokenize does.
func NormTerm(term string) string {
	toks := Tokenize(term)
	if len(toks) == 0 {
		return ""
	}
	return toks[0]
}
