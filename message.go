package dataeng

import "fmt"

// Message is one MSH-delimited message. It retains every original segment,
// including segments that could not be decoded, so Raw returns a byte-exact
// replay of the complete message.
type Message struct {
	Index        int
	SectionIndex int
	StartLine    int
	EndLine      int
	Offset       int
	EndOffset    int
	Segments     []*Segment
	MSH          *Segment
	Delimiters   Delimiters
	Err          *ParseError
	Errors       []*ParseError
	raw          []byte
}

// Raw returns a copy of the complete original message bytes, including
// original segment terminators.
func (m *Message) Raw() []byte {
	if m == nil {
		return nil
	}
	if m.raw != nil {
		return append([]byte(nil), m.raw...)
	}
	var raw []byte
	for _, segment := range m.Segments {
		raw = append(raw, segment.RawBytes()...)
	}
	return raw
}

// RawString returns the exact original message as a string.
func (m *Message) RawString() string {
	return string(m.Raw())
}

// Valid reports whether every segment in the message decoded successfully.
func (m *Message) Valid() bool {
	return m != nil && m.Err == nil
}

// Segment returns the first segment with the requested three-character ID.
func (m *Message) Segment(id string) *Segment {
	if m == nil {
		return nil
	}
	for _, segment := range m.Segments {
		if segment.ID == id {
			return segment
		}
	}
	return nil
}

// AllSegments returns every segment with the requested ID in message order.
func (m *Message) AllSegments(id string) []*Segment {
	if m == nil {
		return nil
	}
	segments := make([]*Segment, 0, 2)
	for _, segment := range m.Segments {
		if segment.ID == id {
			segments = append(segments, segment)
		}
	}
	return segments
}

// Field returns a one-based field from the first segment with segmentID.
func (m *Message) Field(segmentID string, number int) *Field {
	segment := m.Segment(segmentID)
	if segment == nil {
		return nil
	}
	return segment.Field(number)
}

// Value returns a decoded one-based field from the first matching segment.
func (m *Message) Value(segmentID string, number int) string {
	field := m.Field(segmentID, number)
	if field == nil {
		return ""
	}
	return field.Value()
}

// Type returns MSH-9 split into message code, trigger event and structure
// components. Missing components are empty strings.
func (m *Message) Type() (code string, trigger string, structure string) {
	field := m.Field("MSH", 9)
	if field == nil || len(field.Repetitions) == 0 {
		return "", "", ""
	}
	components := field.Repetitions[0].Components
	if len(components) > 0 {
		code = components[0].Value()
	}
	if len(components) > 1 {
		trigger = components[1].Value()
	}
	if len(components) > 2 {
		structure = components[2].Value()
	}
	return code, trigger, structure
}

func (m *Message) finish(data []byte) {
	if m == nil {
		return
	}
	if len(m.Segments) == 0 {
		return
	}
	last := m.Segments[len(m.Segments)-1]
	m.EndLine = last.Line
	m.EndOffset = last.EndOffset + len(last.Terminator)
	if m.Offset >= 0 && m.EndOffset >= m.Offset && m.EndOffset <= len(data) {
		m.raw = append([]byte(nil), data[m.Offset:m.EndOffset]...)
	}
	for _, parseErr := range m.Errors {
		if len(parseErr.RawMessage) == 0 {
			parseErr.RawMessage = append([]byte(nil), m.raw...)
		}
	}
}

func (m *Message) addError(parseErr *ParseError) {
	if m == nil || parseErr == nil {
		return
	}
	m.Errors = append(m.Errors, parseErr)
	if parseErr.Message == nil {
		parseErr.Message = m
	}
	if parseErr.MessageIndex == 0 {
		parseErr.MessageIndex = m.Index
	}
	if parseErr.MessageSegmentIndex == 0 {
		parseErr.MessageSegmentIndex = len(m.Segments)
	}
	if m.Err == nil {
		m.Err = parseErr
	}
}

func (m *Message) String() string {
	if m == nil {
		return "<nil>"
	}
	code, trigger, _ := m.Type()
	return fmt.Sprintf(
		"Message{%d, %s^%s, lines %d-%d, %d segments}",
		m.Index,
		code,
		trigger,
		m.StartLine,
		m.EndLine,
		len(m.Segments),
	)
}
