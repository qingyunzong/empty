package dataeng

import "fmt"

// Segment is one original HL7 segment. Raw excludes the segment terminator;
// Terminator holds the exact CR, LF or CRLF bytes that followed it.
type Segment struct {
	ID                  string
	Index               int
	MessageIndex        int
	MessageSegmentIndex int
	Line                int
	Offset              int
	EndOffset           int
	Raw                 string
	Terminator          string
	Delimiters          Delimiters
	Fields              []Field
	Err                 *ParseError
	message             *Message
}

// RawLine returns the segment and its original line terminator.
func (s *Segment) RawLine() string {
	if s == nil {
		return ""
	}
	return s.Raw + s.Terminator
}

// RawBytes returns the exact original bytes for this segment, including its
// original terminator.
func (s *Segment) RawBytes() []byte {
	if s == nil {
		return nil
	}
	return []byte(s.RawLine())
}

// Field returns a one-based field number. MSH-1 is the field separator and
// MSH-2 contains the encoding characters, matching HL7's numbering.
func (s *Segment) Field(number int) *Field {
	if s == nil || number < 1 || number > len(s.Fields) {
		return nil
	}
	return &s.Fields[number-1]
}

// Value returns the decoded value of a one-based field.
func (s *Segment) Value(number int) string {
	field := s.Field(number)
	if field == nil {
		return ""
	}
	return field.Value()
}

// Values returns the decoded first-component value of every field.
func (s *Segment) Values() []string {
	if s == nil {
		return nil
	}
	values := make([]string, len(s.Fields))
	for i := range s.Fields {
		values[i] = s.Fields[i].Value()
	}
	return values
}

// ComponentValue returns a one-based component from a one-based field and
// repetition.
func (s *Segment) ComponentValue(fieldNumber int, repetitionNumber int, componentNumber int) string {
	field := s.Field(fieldNumber)
	if field == nil {
		return ""
	}
	return field.ComponentValue(repetitionNumber, componentNumber)
}

// Replays returns this segment and, when the segment belongs to a message, the
// complete byte-exact message containing it.
func (s *Segment) Replays() (segment []byte, message []byte) {
	if s == nil {
		return nil, nil
	}
	if s.message == nil {
		return s.RawBytes(), nil
	}
	return s.RawBytes(), s.message.Raw()
}

// Field is one HL7 field. Number is one-based. Raw retains the exact field
// text; the repetition tree contains decoded leaf values.
type Field struct {
	Number      int
	Raw         string
	Repetitions []Repetition
}

// Value returns the first component of the first repetition.
func (f *Field) Value() string {
	if f == nil || len(f.Repetitions) == 0 {
		return ""
	}
	return f.Repetitions[0].Value()
}

// Text is an alias for Value.
func (f *Field) Text() string {
	return f.Value()
}

// String implements fmt.Stringer.
func (f *Field) String() string {
	return f.Value()
}

// Values returns the first component of every repetition.
func (f *Field) Values() []string {
	if f == nil {
		return nil
	}
	values := make([]string, len(f.Repetitions))
	for i := range f.Repetitions {
		values[i] = f.Repetitions[i].Value()
	}
	return values
}

// ComponentValue returns a one-based component from a one-based repetition.
func (f *Field) ComponentValue(repetitionNumber int, componentNumber int) string {
	if f == nil ||
		repetitionNumber < 1 ||
		repetitionNumber > len(f.Repetitions) {
		return ""
	}
	repetition := &f.Repetitions[repetitionNumber-1]
	if componentNumber < 1 || componentNumber > len(repetition.Components) {
		return ""
	}
	return repetition.Components[componentNumber-1].Value()
}

// Repetition is one repetition of a field.
type Repetition struct {
	Raw        string
	Components []Component
}

// Value returns the first component.
func (r *Repetition) Value() string {
	if r == nil || len(r.Components) == 0 {
		return ""
	}
	return r.Components[0].Value()
}

// Text is an alias for Value.
func (r *Repetition) Text() string {
	return r.Value()
}

// Component is one component of a repetition.
type Component struct {
	Raw           string
	Subcomponents []Subcomponent
}

// Value returns the first subcomponent.
func (c *Component) Value() string {
	if c == nil || len(c.Subcomponents) == 0 {
		return ""
	}
	return c.Subcomponents[0].Value
}

// Text is an alias for Value.
func (c *Component) Text() string {
	return c.Value()
}

// Subcomponent is the leaf of an HL7 field tree.
type Subcomponent struct {
	Raw   string
	Value string
}

func baseSegment(record rawRecord, index int) *Segment {
	return &Segment{
		ID:         record.id,
		Index:      index,
		Line:       record.line,
		Offset:     record.offset,
		EndOffset:  record.endOffset,
		Raw:        record.content,
		Terminator: record.terminator,
	}
}

func parseHeaderSegment(
	record rawRecord,
	index int,
	delimiters Delimiters,
) (*Segment, error) {
	segment := baseSegment(record, index)
	segment.Delimiters = delimiters

	encodingEnd, parsed, fieldStart, err := parseHeaderLayout(record.content)
	if err != nil {
		return segment, err
	}
	if parsed != delimiters {
		return segment, fmt.Errorf("hl7: header delimiters changed while parsing %s", record.id)
	}

	segment.Fields = append(
		segment.Fields,
		directField(1, record.content[3:4]),
		directField(2, record.content[4:encodingEnd]),
	)
	if fieldStart < len(record.content) {
		fields, parseErr := parseFieldSpans(
			record.content,
			fieldStart,
			len(record.content),
			3,
			delimiters,
		)
		segment.Fields = append(segment.Fields, fields...)
		if parseErr != nil {
			return segment, parseErr
		}
	} else if encodingEnd < len(record.content) {
		// The MSH-2 separator was the final byte. It denotes an empty MSH-3.
		field, parseErr := parseField(
			record.content,
			span{start: fieldStart, end: fieldStart},
			3,
			delimiters,
		)
		if parseErr != nil {
			return segment, parseErr
		}
		segment.Fields = append(segment.Fields, field)
	}
	return segment, nil
}

func parseSegment(
	record rawRecord,
	index int,
	delimiters Delimiters,
) (*Segment, error) {
	segment := baseSegment(record, index)
	segment.Delimiters = delimiters
	if record.content == record.id {
		return segment, nil
	}
	if len(record.content) <= 3 || record.content[3] != delimiters.Field {
		return segment, fmt.Errorf(
			"hl7: %s segment does not use field separator %q",
			record.id,
			delimiters.Field,
		)
	}
	fields, err := parseFieldSpans(
		record.content,
		4,
		len(record.content),
		1,
		delimiters,
	)
	segment.Fields = fields
	return segment, err
}

func parseFieldSpans(
	raw string,
	start int,
	end int,
	firstNumber int,
	delimiters Delimiters,
) ([]Field, error) {
	spans, err := splitUnescaped(raw, start, end, delimiters.Field, delimiters.Escape)
	if err != nil {
		return nil, err
	}
	fields := make([]Field, 0, len(spans))
	for i, fieldSpan := range spans {
		field, fieldErr := parseField(raw, fieldSpan, firstNumber+i, delimiters)
		fields = append(fields, field)
		if fieldErr != nil {
			return fields, fieldErr
		}
	}
	return fields, nil
}

func parseField(
	raw string,
	fieldSpan span,
	number int,
	delimiters Delimiters,
) (Field, error) {
	field := Field{Number: number, Raw: fieldSpan.text(raw)}
	repetitionSpans, err := splitUnescaped(
		raw,
		fieldSpan.start,
		fieldSpan.end,
		delimiters.Repetition,
		delimiters.Escape,
	)
	if err != nil {
		return field, err
	}

	for _, repetitionSpan := range repetitionSpans {
		repetition := Repetition{Raw: repetitionSpan.text(raw)}
		componentSpans, err := splitUnescaped(
			raw,
			repetitionSpan.start,
			repetitionSpan.end,
			delimiters.Component,
			delimiters.Escape,
		)
		if err != nil {
			return field, err
		}
		for _, componentSpan := range componentSpans {
			component := Component{Raw: componentSpan.text(raw)}
			subcomponentSpans, err := splitUnescaped(
				raw,
				componentSpan.start,
				componentSpan.end,
				delimiters.Subcomponent,
				delimiters.Escape,
			)
			if err != nil {
				return field, err
			}
			for _, subcomponentSpan := range subcomponentSpans {
				rawValue := subcomponentSpan.text(raw)
				value, err := Unescape(rawValue, delimiters)
				if err != nil {
					if escapeErr, ok := err.(*EscapeError); ok {
						return field, &segmentValueError{
							err:           escapeErr,
							segmentOffset: subcomponentSpan.start + escapeErr.Offset,
						}
					}
					return field, err
				}
				component.Subcomponents = append(
					component.Subcomponents,
					Subcomponent{Raw: rawValue, Value: value},
				)
			}
			repetition.Components = append(repetition.Components, component)
		}
		field.Repetitions = append(field.Repetitions, repetition)
	}
	return field, nil
}

func directField(number int, raw string) Field {
	return Field{
		Number: number,
		Raw:    raw,
		Repetitions: []Repetition{{
			Raw: raw,
			Components: []Component{{
				Raw: raw,
				Subcomponents: []Subcomponent{{
					Raw:   raw,
					Value: raw,
				}},
			}},
		}},
	}
}
