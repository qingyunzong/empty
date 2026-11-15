package dataeng

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// EscapeError describes a malformed or unsupported HL7 escape sequence.
// Offset is the zero-based byte position within the value passed to Unescape.
type EscapeError struct {
	Offset int
	Code   string
	Detail string
}

func (e *EscapeError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("hl7: malformed escape at byte %d: %s", e.Offset, e.Detail)
	}
	return fmt.Sprintf(
		"hl7: malformed escape %q at byte %d: %s",
		e.Code,
		e.Offset,
		e.Detail,
	)
}

// Unescape decodes HL7 escape sequences in a leaf value. Structural
// separators are not interpreted here. Unknown escape codes are preserved
// verbatim so vendor escapes survive a round trip; an unterminated escape is
// reported as an error.
func Unescape(value string, delimiters Delimiters) (string, error) {
	if delimiters.Escape == 0 {
		return "", fmt.Errorf("hl7: escape character is not set")
	}

	var decoded strings.Builder
	decoded.Grow(len(value))

	for i := 0; i < len(value); {
		if value[i] != delimiters.Escape {
			decoded.WriteByte(value[i])
			i++
			continue
		}

		end := strings.IndexByte(value[i+1:], delimiters.Escape)
		if end < 0 {
			return "", &EscapeError{
				Offset: i,
				Detail: "unterminated escape sequence",
			}
		}
		end += i + 1
		code := value[i+1 : end]
		replacement, known, err := decodeEscapeCode(code, delimiters, i)
		if err != nil {
			return "", err
		}
		if known {
			decoded.WriteString(replacement)
		} else {
			decoded.WriteString(value[i : end+1])
		}
		i = end + 1
	}
	return decoded.String(), nil
}

func decodeEscapeCode(
	code string,
	delimiters Delimiters,
	offset int,
) (string, bool, error) {
	if code == "" {
		return string(delimiters.Escape), true, nil
	}

	switch code[0] {
	case 'F', 'f':
		if len(code) == 1 {
			return string(delimiters.Field), true, nil
		}
	case 'S', 's':
		if len(code) == 1 {
			return string(delimiters.Component), true, nil
		}
	case 'R', 'r':
		if len(code) == 1 {
			return string(delimiters.Repetition), true, nil
		}
	case 'T', 't':
		if len(code) == 1 {
			return string(delimiters.Subcomponent), true, nil
		}
	case 'E', 'e':
		if len(code) == 1 {
			return string(delimiters.Escape), true, nil
		}
	case 'X', 'x':
		if len(code) == 1 {
			return "", false, &EscapeError{
				Offset: offset,
				Code:   code,
				Detail: "hex escape has no digits",
			}
		}
		payload := code[1:]
		if len(payload)%2 != 0 {
			return "", false, &EscapeError{
				Offset: offset,
				Code:   code,
				Detail: "hex escape must contain an even number of digits",
			}
		}
		raw, err := hex.DecodeString(payload)
		if err != nil {
			return "", false, &EscapeError{
				Offset: offset,
				Code:   code,
				Detail: "hex escape contains a non-hex digit",
			}
		}
		return string(raw), true, nil
	case '.', 'H', 'h', 'N', 'n':
		switch code {
		case ".br", ".BR":
			return "\n", true, nil
		case "H", "h", "N", "n":
			return "", true, nil
		}
	}
	return "", false, nil
}

// splitUnescaped splits a byte range on separator while treating escape
// sequences as opaque. Escape sequences are not validated here; Unescape does
// that after structural splitting. The returned spans use offsets in raw.
func splitUnescaped(
	raw string,
	start int,
	end int,
	separator byte,
	escape byte,
) ([]span, error) {
	if start < 0 || end < start || end > len(raw) {
		return nil, fmt.Errorf("hl7: invalid split range [%d,%d)", start, end)
	}
	if separator == 0 {
		return nil, fmt.Errorf("hl7: separator is not set")
	}

	spans := make([]span, 0, 4)
	partStart := start
	for i := start; i < end; {
		if escape != 0 && raw[i] == escape {
			next := strings.IndexByte(raw[i+1:end], escape)
			if next < 0 {
				return nil, &EscapeError{
					Offset: i,
					Detail: "unterminated escape sequence",
				}
			}
			i += next + 2
			continue
		}
		if raw[i] == separator {
			spans = append(spans, span{start: partStart, end: i})
			partStart = i + 1
		}
		i++
	}
	spans = append(spans, span{start: partStart, end: end})
	return spans, nil
}

type span struct {
	start int
	end   int
}

func (s span) text(raw string) string {
	return raw[s.start:s.end]
}

type segmentValueError struct {
	err           *EscapeError
	segmentOffset int
}

func (e *segmentValueError) Error() string {
	return e.err.Error()
}

func (e *segmentValueError) Unwrap() error {
	return e.err
}

func (e *segmentValueError) SegmentOffset() int {
	return e.segmentOffset
}

func escapeColumn(raw string, err error) int {
	var escapeErr *EscapeError
	if !errors.As(err, &escapeErr) {
		return 0
	}
	offset := escapeErr.Offset
	var located interface {
		SegmentOffset() int
	}
	if errors.As(err, &located) {
		offset = located.SegmentOffset()
	}
	column := offset + 1
	if column < 1 {
		return 1
	}
	if column > len(raw)+1 {
		return len(raw) + 1
	}
	return column
}
