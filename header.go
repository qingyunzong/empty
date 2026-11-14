package dataeng

import (
	"strings"
	"unicode"
)

type headerSignature struct {
	fields   []string
	text     string
	nonEmpty int
}

func buildHeaderSignature(rows []*rowRef, columnCount int) headerSignature {
	if len(rows) == 0 || columnCount <= 0 {
		return headerSignature{}
	}
	fields := make([]string, columnCount)
	for col := 0; col < columnCount; col++ {
		var rowParts []string
		for _, row := range rows {
			var cellParts []string
			for _, c := range row.cells {
				if col < c.column || col >= c.column+c.colSpan {
					continue
				}
				text := normalizeHeaderText(c.cell.Text)
				if text != "" {
					cellParts = append(cellParts, text)
				}
			}
			if len(cellParts) > 0 {
				rowParts = append(rowParts, strings.Join(cellParts, " "))
			}
		}
		fields[col] = strings.Join(rowParts, " / ")
	}
	nonEmpty := 0
	for _, f := range fields {
		if f != "" {
			nonEmpty++
		}
	}
	return headerSignature{
		fields:   fields,
		text:     strings.Join(fields, " | "),
		nonEmpty: nonEmpty,
	}
}

func normalizeHeaderText(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ")
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case '\u3000':
			continue
		case '（':
			r = '('
		case '）':
			r = ')'
		case '：':
			r = ':'
		case '，':
			r = ','
		case '；':
			r = ';'
		case '．':
			r = '.'
		case '％':
			r = '%'
		}
		if unicode.IsSpace(r) {
			continue
		}
		switch r {
		case '.', ',', ':', ';', '!', '?', '、', '·', '_', '-', '–', '—':
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

func headerSimilarity(a, b headerSignature) float64 {
	if len(a.fields) == 0 || len(b.fields) == 0 {
		return 0
	}
	if a.nonEmpty == 0 || b.nonEmpty == 0 {
		return 0
	}
	if len(a.fields) != len(b.fields) {
		return 0
	}
	var weighted, weightSum float64
	for i := range a.fields {
		af, bf := a.fields[i], b.fields[i]
		if af == "" && bf == "" {
			continue
		}
		weight := float64(maxInt(runeLen(af), runeLen(bf)))
		if weight < 1 {
			weight = 1
		}
		weighted += textSimilarity(af, bf) * weight
		weightSum += weight
	}
	if weightSum == 0 {
		return 0
	}
	return weighted / weightSum
}

func textSimilarity(a, b string) float64 {
	if a == b {
		return 1
	}
	if a == "" || b == "" {
		return 0
	}
	ar, br := []rune(a), []rune(b)
	if len(ar) == 0 || len(br) == 0 {
		return 0
	}
	if len(ar) > 240 {
		ar = ar[:240]
	}
	if len(br) > 240 {
		br = br[:240]
	}
	// Levenshtein distance over runes. Header signatures are short, and this
	// is the only place where text is compared at all.
	prev := make([]int, len(br)+1)
	cur := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		cur[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			cur[j] = minInt(
				cur[j-1]+1,
				prev[j]+1,
				prev[j-1]+cost,
			)
		}
		prev, cur = cur, prev
	}
	dist := prev[len(br)]
	longest := maxInt(len(ar), len(br))
	return clamp01(1 - float64(dist)/float64(longest))
}

func runeLen(s string) int {
	n := 0
	for range s {
		n++
	}
	return n
}

func minInt(values ...int) int {
	best := values[0]
	for _, v := range values[1:] {
		if v < best {
			best = v
		}
	}
	return best
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
