package dataeng

import (
	"fmt"
	"strings"
)

type digitChar struct {
	digit   byte
	pos     int
	inParen bool
}

type extensionMatch struct {
	marker     string
	markerSpan Span
	digits     string
	digitsSpan Span
}

type preparedInput struct {
	raw string

	schemeSpan Span
	hasScheme  bool

	mainStart int
	mainEnd   int

	plus    bool
	plusPos int

	digits []digitChar
	ext    extensionMatch
	hasExt bool

	issues []Issue
}

func prepareInput(input string) preparedInput {
	p := preparedInput{raw: input, mainEnd: len(input)}

	start := 0
	for start < len(input) && isASCIISpace(rune(input[start])) {
		start++
	}
	if len(input)-start >= 4 && strings.EqualFold(input[start:start+4], "tel:") {
		p.hasScheme = true
		p.schemeSpan = Span{Start: start, End: start + 4}
		start += 4
	}
	p.mainStart = start

	if mainEnd, ext, ok := findExtension(input, start); ok {
		p.mainEnd = mainEnd
		p.ext = ext
		p.hasExt = true
	}

	first := start
	for first < p.mainEnd && isASCIISpace(rune(input[first])) {
		first++
	}
	if first < p.mainEnd && input[first] == '+' {
		p.plus = true
		p.plusPos = first
	}

	p.digits, p.issues = scanDigits(input, start, p.mainEnd, p.plusPos)
	return p
}

func findExtension(input string, start int) (int, extensionMatch, bool) {
	lower := asciiLower(input)
	for i := len(input) - 1; i >= start; i-- {
		markerLen := 0
		marker := ""

		switch {
		case strings.HasPrefix(lower[i:], ";extension="):
			markerLen, marker = len(";extension="), ";extension="
		case strings.HasPrefix(lower[i:], ";ext="):
			markerLen, marker = len(";ext="), ";ext="
		case strings.HasPrefix(lower[i:], "extension"):
			markerLen, marker = len("extension"), "extension"
		case strings.HasPrefix(lower[i:], "ext"):
			markerLen, marker = len("ext"), "ext"
		case lower[i] == 'x':
			markerLen, marker = 1, "x"
		case lower[i] == '#':
			markerLen, marker = 1, "#"
		default:
			continue
		}

		markerStart := i
		markerEnd := i + markerLen

		if marker != ";ext=" && marker != ";extension=" {
			if i > start && isASCIILetter(input[i-1]) {
				continue
			}
			if markerEnd < len(input) && isASCIILetter(input[markerEnd]) {
				continue
			}
		}

		if (marker == "ext" || marker == "extension") &&
			markerStart > start && input[markerStart-1] == ';' &&
			markerEnd < len(input) && input[markerEnd] == '=' {
			markerStart--
			markerEnd++
			marker = ";" + marker + "="
		}

		j := markerEnd
		for j < len(input) && isExtensionLeadSeparator(input[j]) {
			j++
		}
		if j >= len(input) || !isASCIIDigit(input[j]) {
			continue
		}

		digitsStart := j
		var digits strings.Builder
		lastDigitEnd := j
		valid := true
		for j < len(input) {
			c := input[j]
			switch {
			case isASCIIDigit(c):
				digits.WriteByte(c)
				j++
				lastDigitEnd = j
			case isExtensionTailSeparator(c):
				j++
			default:
				valid = false
			}
			if !valid {
				break
			}
		}
		if !valid || digits.Len() == 0 {
			continue
		}

		return markerStart, extensionMatch{
			marker:     marker,
			markerSpan: Span{Start: markerStart, End: markerEnd},
			digits:     digits.String(),
			digitsSpan: Span{Start: digitsStart, End: lastDigitEnd},
		}, true
	}
	return len(input), extensionMatch{}, false
}

func scanDigits(input string, start, end, plusPos int) ([]digitChar, []Issue) {
	var digits []digitChar
	var issues []Issue
	depth := 0
	unrecognizedStart := -1

	flushUnrecognized := func(at int) {
		if unrecognizedStart < 0 {
			return
		}
		issues = append(issues, Issue{
			Code:     IssueUnrecognizedCharacters,
			Severity: SeverityWarning,
			Message:  "characters were not part of the telephone number",
			Span:     Span{Start: unrecognizedStart, End: at},
		})
		unrecognizedStart = -1
	}

	for pos := start; pos < end; pos++ {
		c := input[pos]
		switch {
		case isASCIIDigit(c):
			flushUnrecognized(pos)
			digits = append(digits, digitChar{digit: c, pos: pos, inParen: depth > 0})
		case c == '(':
			flushUnrecognized(pos)
			depth++
		case c == ')':
			flushUnrecognized(pos)
			if depth == 0 {
				issues = append(issues, Issue{
					Code:     IssueUnbalancedParenthesis,
					Severity: SeverityWarning,
					Message:  "unmatched closing parenthesis",
					Span:     Span{Start: pos, End: pos + 1},
				})
			} else {
				depth--
			}
		case c == '+':
			flushUnrecognized(pos)
			if pos != plusPos {
				issues = append(issues, Issue{
					Code:     IssueMultiplePlus,
					Severity: SeverityWarning,
					Message:  "only a leading plus sign is treated as an international marker",
					Span:     Span{Start: pos, End: pos + 1},
				})
			}
		case isPhoneSeparator(c) || isASCIISpace(rune(c)):
			flushUnrecognized(pos)
		default:
			if unrecognizedStart < 0 {
				unrecognizedStart = pos
			}
		}
	}
	flushUnrecognized(end)
	if depth > 0 {
		issues = append(issues, Issue{
			Code:     IssueUnbalancedParenthesis,
			Severity: SeverityWarning,
			Message:  "unclosed parenthesis",
			Span:     Span{Start: end, End: end},
		})
	}
	return digits, issues
}

func isASCIIDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func asciiLower(value string) string {
	lowered := []byte(value)
	for index, c := range lowered {
		if c >= 'A' && c <= 'Z' {
			lowered[index] = c + ('a' - 'A')
		}
	}
	return string(lowered)
}

func isASCIISpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r'
}

func isPhoneSeparator(c byte) bool {
	switch c {
	case '-', '.', '/', '\\', '_', ',', ';', ':', '~':
		return true
	default:
		return false
	}
}

func isExtensionLeadSeparator(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '.', ':', '=', '-', '(', ')', ',', ';', '/':
		return true
	default:
		return false
	}
}

func isExtensionTailSeparator(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '.', '-', '(', ')', '/', ',':
		return true
	default:
		return false
	}
}

func digitText(input string, digits []digitChar, start, count int) string {
	if count <= 0 || start < 0 || start+count > len(digits) {
		return ""
	}
	span := digitSpan(digits, start, count)
	if span.Start < 0 || span.End > len(input) || span.Start > span.End {
		return ""
	}
	return input[span.Start:span.End]
}

func digitSpan(digits []digitChar, start, count int) Span {
	if count <= 0 || start < 0 || start+count > len(digits) {
		return Span{}
	}
	return Span{Start: digits[start].pos, End: digits[start+count-1].pos + 1}
}

func digitsString(digits []digitChar, start, count int) string {
	if count <= 0 || start < 0 || start+count > len(digits) {
		return ""
	}
	var builder strings.Builder
	for index := start; index < start+count; index++ {
		builder.WriteByte(digits[index].digit)
	}
	return builder.String()
}

func digitPrefixMatches(digits []digitChar, start int, prefix string) bool {
	if prefix == "" || start < 0 || start+len(prefix) > len(digits) {
		return false
	}
	for index := 0; index < len(prefix); index++ {
		if digits[start+index].digit != prefix[index] {
			return false
		}
	}
	return true
}

func allInParentheses(digits []digitChar, start, count int) bool {
	if count <= 0 || start < 0 || start+count > len(digits) {
		return false
	}
	for index := start; index < start+count; index++ {
		if !digits[index].inParen {
			return false
		}
	}
	return true
}

func issue(code IssueCode, severity Severity, span Span, format string, args ...any) Issue {
	return Issue{Code: code, Severity: severity, Span: span, Message: fmt.Sprintf(format, args...)}
}
