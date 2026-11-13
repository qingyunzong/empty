package dataeng

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// ErrUndecided is returned when an incomplete sample is cut through a BOM or
// a possible meta declaration.
var ErrUndecided = errors.New("dataeng: charset is undecided")

// ErrUnsupportedCharset is returned when a selected charset cannot be
// decoded by this package.
var ErrUnsupportedCharset = errors.New("dataeng: unsupported charset")

// Decoded is a completed charset decision and its decoded text.
type Decoded struct {
	Charset      string
	Source       Source
	BOMLen       int
	HasBOM       bool
	Text         string
	Replacements int
	Undecided    bool
	Reason       string
}

// DecodePage resolves a charset from the body and decodes it, removing a
// recognized BOM first. Only the first SniffLimit bytes are inspected when
// resolving; complete has the same meaning as in Resolve.
//
// If the decision is undecided, the returned Decoded has Undecided set and
// the error wraps ErrUndecided. An unknown selected charset returns
// ErrUnsupportedCharset.
func DecodePage(transportCharset string, body []byte, complete bool) (Decoded, error) {
	sample := body
	if len(sample) > SniffLimit {
		sample = sample[:SniffLimit]
	}
	return DecodeWithDecision(body, Resolve(transportCharset, sample, complete))
}

// DecodeWithDecision decodes a complete body using a decision already made
// from its leading bytes. The decision's BOMLen bytes are discarded before
// decoding. This is useful when Resolve examined a prefix but the caller has
// the whole body available.
func DecodeWithDecision(body []byte, decision Decision) (Decoded, error) {
	result := Decoded{
		Charset:   decision.Charset,
		Source:    decision.Source,
		BOMLen:    decision.BOMLen,
		HasBOM:    decision.HasBOM,
		Undecided: decision.Undecided,
		Reason:    decision.Reason,
	}
	if decision.Undecided {
		return result, ErrUndecided
	}

	start := decision.BOMLen
	if start > len(body) {
		start = len(body)
	}
	text, replacements, err := Decode(decision.Charset, body[start:])
	if err != nil {
		return result, err
	}
	result.Text = text
	result.Replacements = replacements
	return result, nil
}

// Decode decodes data with charset. It does not remove a BOM; use
// DecodePage or DecodeWithDecision when a BOM may be present.
//
// Invalid input units are each replaced by one U+FFFD and counted. A
// replacement never consumes a following byte or code unit: the next input
// unit is decoded independently.
func Decode(charset string, data []byte) (text string, replacements int, err error) {
	switch canonicalCharset(charset) {
	case "", UTF8:
		return decodeUTF8(data)
	case UTF16LE:
		return decodeUTF16(data, false)
	case UTF16BE:
		return decodeUTF16(data, true)
	case Windows1252:
		return decodeWindows1252(data), 0, nil
	case ISO88591:
		return decodeISO88591(data), 0, nil
	case USASCII:
		return decodeASCII(data)
	default:
		return "", 0, fmt.Errorf("%w: %q", ErrUnsupportedCharset, charset)
	}
}

// DecodeBytes is Decode with the data argument first.
func DecodeBytes(data []byte, charset string) (text string, replacements int, err error) {
	return Decode(charset, data)
}

// DecodeString is an alias for Decode.
func DecodeString(charset string, data []byte) (text string, replacements int, err error) {
	return Decode(charset, data)
}

func decodeUTF8(data []byte) (string, int, error) {
	var builder strings.Builder
	builder.Grow(len(data))
	replacements := 0
	for len(data) > 0 {
		r, size := utf8.DecodeRune(data)
		if r == utf8.RuneError && size == 1 {
			builder.WriteString("\uFFFD")
			replacements++
			data = data[1:]
			continue
		}
		builder.Write(data[:size])
		data = data[size:]
	}
	return builder.String(), replacements, nil
}

func decodeUTF16(data []byte, bigEndian bool) (string, int, error) {
	var builder strings.Builder
	builder.Grow(len(data))
	replacements := 0

	readUnit := func(value []byte) uint16 {
		if bigEndian {
			return uint16(value[0])<<8 | uint16(value[1])
		}
		return uint16(value[0]) | uint16(value[1])<<8
	}

	for len(data) >= 2 {
		unit := readUnit(data)
		switch {
		case unit >= 0xD800 && unit <= 0xDBFF:
			if len(data) >= 4 {
				next := readUnit(data[2:])
				if next >= 0xDC00 && next <= 0xDFFF {
					r := rune(0x10000 + (uint32(unit-0xD800) << 10) + uint32(next-0xDC00))
					builder.WriteRune(r)
					data = data[4:]
					continue
				}
			}
			builder.WriteString("\uFFFD")
			replacements++
			data = data[2:]
		case unit >= 0xDC00 && unit <= 0xDFFF:
			builder.WriteString("\uFFFD")
			replacements++
			data = data[2:]
		default:
			builder.WriteRune(rune(unit))
			data = data[2:]
		}
	}
	if len(data) == 1 {
		builder.WriteString("\uFFFD")
		replacements++
	}
	return builder.String(), replacements, nil
}

func decodeWindows1252(data []byte) string {
	var builder strings.Builder
	builder.Grow(len(data))
	for _, value := range data {
		if value >= 0x80 && value <= 0x9F {
			builder.WriteRune(windows1252High[value-0x80])
			continue
		}
		builder.WriteRune(rune(value))
	}
	return builder.String()
}

func decodeISO88591(data []byte) string {
	var builder strings.Builder
	builder.Grow(len(data))
	for _, value := range data {
		builder.WriteRune(rune(value))
	}
	return builder.String()
}

func decodeASCII(data []byte) (string, int, error) {
	var builder strings.Builder
	builder.Grow(len(data))
	replacements := 0
	for _, value := range data {
		if value >= 0x80 {
			builder.WriteString("\uFFFD")
			replacements++
			continue
		}
		builder.WriteByte(value)
	}
	return builder.String(), replacements, nil
}

var windows1252High = [32]rune{
	0x20AC, 0x0081, 0x201A, 0x0192,
	0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039,
	0x0152, 0x008D, 0x017D, 0x008F,
	0x0090, 0x2018, 0x2019, 0x201C,
	0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A,
	0x0153, 0x009D, 0x017E, 0x0178,
}
