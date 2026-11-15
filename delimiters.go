package dataeng

import (
	"fmt"
	"strings"
)

// Delimiters are the five HL7 v2 delimiters. Field is MSH-1; the other four
// values are the four encoding characters in MSH-2:
// component, repetition, escape and subcomponent.
type Delimiters struct {
	Field        byte
	Component    byte
	Repetition   byte
	Escape       byte
	Subcomponent byte
}

// DefaultDelimiters returns the standard HL7 v2 delimiters, |^~\&.
func DefaultDelimiters() Delimiters {
	return Delimiters{
		Field:        '|',
		Component:    '^',
		Repetition:   '~',
		Escape:       '\\',
		Subcomponent: '&',
	}
}

// EncodingCharacters returns the four encoding characters in MSH-2 order.
func (d Delimiters) EncodingCharacters() string {
	return string([]byte{d.Component, d.Repetition, d.Escape, d.Subcomponent})
}

// Validate reports whether the delimiter set can be used to parse a segment.
func (d Delimiters) Validate() error {
	values := []struct {
		name  string
		value byte
	}{
		{"field separator", d.Field},
		{"component separator", d.Component},
		{"repetition separator", d.Repetition},
		{"escape character", d.Escape},
		{"subcomponent separator", d.Subcomponent},
	}
	for _, value := range values {
		if value.value == 0 {
			return fmt.Errorf("hl7: %s is not set", value.name)
		}
		if value.value == '\r' || value.value == '\n' {
			return fmt.Errorf("hl7: %s cannot be a line terminator", value.name)
		}
	}
	for i := range values {
		for j := i + 1; j < len(values); j++ {
			if values[i].value == values[j].value {
				return fmt.Errorf(
					"hl7: %s and %s must differ",
					values[i].name,
					values[j].name,
				)
			}
		}
	}
	return nil
}

// DelimitersFromHeader derives delimiters from an MSH, BHS or FHS segment.
// The input must be one segment without its line terminator.
func DelimitersFromHeader(segment string) (Delimiters, error) {
	_, delimiters, _, err := parseHeaderLayout(segment)
	return delimiters, err
}

// parseHeaderLayout parses the header-specific layout:
//
//	ID + field separator + four (or five in newer v2 releases) encoding chars
//
// It returns the encoding-character end offset and the absolute offset of the
// first ordinary field after MSH-2/BHS-2/FHS-2.
func parseHeaderLayout(segment string) (int, Delimiters, int, error) {
	if len(segment) < 8 {
		return 0, Delimiters{}, 0, fmt.Errorf(
			"hl7: header segment %q is shorter than ID plus delimiters",
			segment,
		)
	}
	if !validSegmentID(segment[:3]) {
		return 0, Delimiters{}, 0, fmt.Errorf("hl7: invalid segment ID %q", segment[:3])
	}

	field := segment[3]
	encodingEnd := 4
	for encodingEnd < len(segment) && segment[encodingEnd] != field {
		encodingEnd++
	}
	encoding := segment[4:encodingEnd]
	if len(encoding) < 4 {
		return 0, Delimiters{}, 0, fmt.Errorf(
			"hl7: %s-2 must contain at least four encoding characters, got %q",
			segment[:3],
			encoding,
		)
	}
	if len(encoding) > 5 {
		return 0, Delimiters{}, 0, fmt.Errorf(
			"hl7: %s-2 contains too many encoding characters: %q",
			segment[:3],
			encoding,
		)
	}

	delimiters := Delimiters{
		Field:        field,
		Component:    encoding[0],
		Repetition:   encoding[1],
		Escape:       encoding[2],
		Subcomponent: encoding[3],
	}
	if err := delimiters.Validate(); err != nil {
		return 0, Delimiters{}, 0, err
	}
	if strings.IndexByte(encoding, field) >= 0 {
		return 0, Delimiters{}, 0, fmt.Errorf(
			"hl7: field separator %q occurs in %s-2",
			field,
			segment[:3],
		)
	}

	fieldStart := len(segment)
	if encodingEnd < len(segment) {
		if segment[encodingEnd] != field {
			return 0, Delimiters{}, 0, fmt.Errorf(
				"hl7: expected %s-2 field separator at byte %d",
				segment[:3],
				encodingEnd,
			)
		}
		fieldStart = encodingEnd + 1
	}
	return encodingEnd, delimiters, fieldStart, nil
}

func validSegmentID(id string) bool {
	if len(id) != 3 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			continue
		}
		return false
	}
	return true
}
