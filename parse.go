package dataeng

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Parse reads change records from r. It does not connect to a directory.
// Malformed records are returned with Err set; parsing always continues with
// the next record. The error return reports an input/output error only.
//
// Without arguments Parse only decodes records. If normalizeDN is supplied,
// records are also applied in order to an in-memory directory and semantic
// failures (such as adding an existing value) are reported in Change.Err. This
// makes Parse equivalent to ReadChanges in that form. Use ParseRecords to
// decode only while still supplying a normalizer.
func Parse(r io.Reader, normalizeDN ...func(string) string) ([]Change, error) {
	if len(normalizeDN) > 0 {
		return ReadChanges(r, normalizeDN[0])
	}
	return parseRecords(r)
}

// ParseChanges is an alias for Parse.
func ParseChanges(r io.Reader, normalizeDN ...func(string) string) ([]Change, error) {
	return Parse(r, normalizeDN...)
}

// ParseRecords decodes change records without applying them.
func ParseRecords(r io.Reader) ([]Change, error) {
	return parseRecords(r)
}

// Decode is an alias for Parse.
func Decode(r io.Reader, normalizeDN ...func(string) string) ([]Change, error) {
	return Parse(r, normalizeDN...)
}

// Decoder reads change records one at a time. Next returns a change with Err
// set for a bad record and keeps reading on the following call. The only error
// returned by Next itself is an input/output error or io.EOF.
type Decoder struct {
	reader *physicalReader
	record int
}

// NewDecoder returns a Decoder reading from r.
func NewDecoder(r io.Reader) *Decoder {
	return &Decoder{reader: newPhysicalReader(r)}
}

// NewParser is an alias for NewDecoder.
func NewParser(r io.Reader) *Decoder {
	return NewDecoder(r)
}

// Next returns the next change record. It does not stop at malformed records.
func (d *Decoder) Next() (*Change, error) {
	if d == nil || d.reader == nil {
		return nil, io.EOF
	}
	for {
		record, err := d.reader.nextRecord()
		if err != nil {
			return nil, err
		}
		change := parseRecord(record, d.record+1)
		if change == nil {
			continue
		}
		d.record++
		return change, nil
	}
}

// ReadAll reads the remaining records.
func (d *Decoder) ReadAll() ([]Change, error) {
	var changes []Change
	for {
		change, err := d.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return changes, nil
			}
			return changes, err
		}
		changes = append(changes, *change)
	}
}

// ReadChanges reads change records and applies them in order to an in-memory
// directory. Distinguished names are compared using normalizeDN; nil means no
// normalization. A record that fails is returned with Err set and does not
// prevent later records from being applied.
func ReadChanges(r io.Reader, normalizeDN func(string) string) ([]Change, error) {
	_, changes, err := Process(r, normalizeDN)
	return changes, err
}

// Process is ReadChanges with the resulting directory returned as well.
func Process(r io.Reader, normalizeDN func(string) string) (*Directory, []Change, error) {
	changes, ioErr := parseRecords(r)
	dir := NewDirectory(normalizeDN)
	for i := range changes {
		change := &changes[i]
		if change.Err != nil {
			continue
		}
		if err := dir.Apply(change); err != nil {
			change.Err = &RecordError{Record: change.Record, Line: change.Line, Err: err}
		}
	}
	return dir, changes, ioErr
}

// ApplyChangeLog is an alias for Process.
func ApplyChangeLog(r io.Reader, normalizeDN func(string) string) (*Directory, []Change, error) {
	return Process(r, normalizeDN)
}

type rawLine struct {
	text   string
	number int
}

type recordIssue struct {
	line int
	err  error
}

type rawRecord struct {
	lines  []rawLine
	issues []recordIssue
}

func (r *rawRecord) startLine() int {
	if len(r.lines) == 0 {
		return 0
	}
	return r.lines[0].number
}

type physicalReader struct {
	reader *bufio.Reader
	line   int
	done   bool
}

func newPhysicalReader(r io.Reader) *physicalReader {
	return &physicalReader{reader: bufio.NewReader(r)}
}

func (p *physicalReader) next() (string, int, error) {
	if p.done {
		return "", 0, io.EOF
	}
	text, err := p.reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", 0, err
	}
	if err != nil && text == "" {
		p.done = true
		return "", 0, io.EOF
	}

	p.line++
	text = strings.TrimSuffix(text, "\n")
	text = strings.TrimSuffix(text, "\r")
	if p.line == 1 {
		text = strings.TrimPrefix(text, "\ufeff")
	}
	if err != nil {
		p.done = true
	}
	return text, p.line, nil
}

func (p *physicalReader) nextRecord() (*rawRecord, error) {
	var record rawRecord
	for {
		text, line, err := p.next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				if len(record.lines) > 0 || len(record.issues) > 0 {
					return &record, nil
				}
				return nil, io.EOF
			}
			return nil, err
		}

		if text == "" {
			if len(record.lines) > 0 || len(record.issues) > 0 {
				return &record, nil
			}
			continue
		}
		if text[0] == '#' {
			continue
		}
		if text[0] == ' ' || text[0] == '\t' {
			if len(record.lines) == 0 {
				record.issues = append(record.issues, recordIssue{
					line: line,
					err:  ErrContinuation,
				})
				record.lines = append(record.lines, rawLine{text: text[1:], number: line})
				continue
			}
			record.lines[len(record.lines)-1].text += text[1:]
			continue
		}
		record.lines = append(record.lines, rawLine{text: text, number: line})
	}
}

func parseRecords(r io.Reader) ([]Change, error) {
	reader := newPhysicalReader(r)
	var changes []Change
	for {
		record, err := reader.nextRecord()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return changes, nil
			}
			return changes, err
		}
		change := parseRecord(record, len(changes)+1)
		if change == nil {
			continue
		}
		changes = append(changes, *change)
	}
}

type parsedAttribute struct {
	name   string
	values []string
	line   int
	err    error
}

func parseAttributeLine(text string, line int) parsedAttribute {
	colon := strings.IndexByte(text, ':')
	if colon <= 0 {
		return parsedAttribute{line: line, err: fmt.Errorf("%w: missing ':'", ErrInvalidAttribute)}
	}
	name := text[:colon]
	if name == "" || strings.TrimSpace(name) != name || strings.ContainsAny(name, " \t:") {
		return parsedAttribute{line: line, err: fmt.Errorf("%w: bad attribute name %q", ErrInvalidAttribute, name)}
	}

	rest := text[colon+1:]
	if strings.HasPrefix(rest, ":") {
		encoded := rest[1:]
		if strings.HasPrefix(encoded, " ") {
			encoded = encoded[1:]
		}
		decoded, err := decodeBase64Value(encoded)
		if err != nil {
			return parsedAttribute{
				name: name,
				line: line,
				err:  fmt.Errorf("%w: attribute %s: %v", ErrInvalidBase64, name, err),
			}
		}
		return parsedAttribute{name: name, values: []string{string(decoded)}, line: line}
	}

	if strings.HasPrefix(rest, " ") {
		rest = rest[1:]
	}
	return parsedAttribute{name: name, values: []string{rest}, line: line}
}

func decodeBase64Value(value string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err == nil {
		return decoded, nil
	}
	if raw, rawErr := base64.RawStdEncoding.DecodeString(value); rawErr == nil {
		return raw, nil
	}
	return nil, err
}

func parseRecord(record *rawRecord, number int) *Change {
	if len(record.lines) == 0 && len(record.issues) == 0 {
		return nil
	}

	if len(record.issues) == 0 && len(record.lines) == 1 {
		attr := parseAttributeLine(record.lines[0].text, record.lines[0].number)
		if attr.err == nil && equalAttributeName(attr.name, "version") {
			return nil
		}
	}

	change := &Change{
		Record: number,
		Line:   record.startLine(),
	}
	for _, issue := range record.issues {
		setChangeError(change, issue.line, issue.err)
	}

	var dnSeen, changeTypeSeen bool
	var rawChangeType string
	var changeTypeLine int
	for i := range record.lines {
		line := &record.lines[i]
		if isModifySeparator(line.text) {
			continue
		}
		attr := parseAttributeLine(line.text, line.number)
		if attr.err != nil {
			setChangeError(change, attr.line, attr.err)
			continue
		}
		switch {
		case equalAttributeName(attr.name, "dn"):
			if dnSeen {
				setChangeError(change, attr.line, fmt.Errorf("%w: repeated dn", ErrInvalidAttribute))
				continue
			}
			dnSeen = true
			if len(attr.values) != 1 || attr.values[0] == "" {
				setChangeError(change, attr.line, ErrMissingDN)
				continue
			}
			change.DN = attr.values[0]
		case equalAttributeName(attr.name, "changetype"):
			if changeTypeSeen {
				setChangeError(change, attr.line, fmt.Errorf("%w: repeated changetype", ErrInvalidAttribute))
				continue
			}
			changeTypeSeen = true
			changeTypeLine = attr.line
			if len(attr.values) != 1 {
				setChangeError(change, attr.line, fmt.Errorf("%w: expected one value", ErrInvalidChangeType))
				continue
			}
			rawChangeType = strings.ToLower(strings.TrimSpace(attr.values[0]))
		}
	}

	if !dnSeen {
		setChangeError(change, change.Line, ErrMissingDN)
	}
	if !changeTypeSeen {
		setChangeError(change, change.Line, fmt.Errorf("%w: missing changetype", ErrInvalidChangeType))
	}

	switch ChangeType(rawChangeType) {
	case ChangeAdd:
		change.Type = ChangeAdd
		parseAddBody(change, record)
	case ChangeModify:
		change.Type = ChangeModify
		parseModifyBody(change, record)
	case ChangeDelete:
		change.Type = ChangeDelete
		parseDeleteBody(change, record)
	default:
		if changeTypeSeen {
			setChangeError(change, changeTypeLine, fmt.Errorf("%w: %q", ErrInvalidChangeType, rawChangeType))
		}
	}

	return change
}

func parseAddBody(change *Change, record *rawRecord) {
	attributes := make([]Attribute, 0, len(record.lines))
	index := make(map[string]int)
	for i := range record.lines {
		line := &record.lines[i]
		if isModifySeparator(line.text) {
			setChangeError(change, line.number, fmt.Errorf("%w: unexpected '-'", ErrInvalidAttribute))
			continue
		}
		attr := parseAttributeLine(line.text, line.number)
		if attr.err != nil {
			setChangeError(change, attr.line, attr.err)
			continue
		}
		if equalAttributeName(attr.name, "dn") || equalAttributeName(attr.name, "changetype") {
			continue
		}
		key := foldAttributeName(attr.name)
		position, ok := index[key]
		if !ok {
			index[key] = len(attributes)
			attributes = append(attributes, Attribute{Name: attr.name})
			position = len(attributes) - 1
		}
		for _, value := range attr.values {
			if containsValue(attributes[position].Values, value) {
				setChangeError(change, attr.line, fmt.Errorf("%w: attribute %s", ErrDuplicateValue, attr.name))
				continue
			}
			attributes[position].Values = append(attributes[position].Values, value)
		}
	}
	change.Attributes = attributes
}

func parseDeleteBody(change *Change, record *rawRecord) {
	for i := range record.lines {
		line := &record.lines[i]
		if isModifySeparator(line.text) {
			setChangeError(change, line.number, fmt.Errorf("%w: unexpected '-'", ErrDeleteWithAttributes))
			continue
		}
		attr := parseAttributeLine(line.text, line.number)
		if attr.err != nil {
			setChangeError(change, attr.line, attr.err)
			continue
		}
		if equalAttributeName(attr.name, "dn") || equalAttributeName(attr.name, "changetype") {
			continue
		}
		setChangeError(change, attr.line, fmt.Errorf("%w: attribute %s", ErrDeleteWithAttributes, attr.name))
	}
}

func parseModifyBody(change *Change, record *rawRecord) {
	opStart := -1
	for i := range record.lines {
		line := &record.lines[i]
		if isModifySeparator(line.text) {
			continue
		}
		attr := parseAttributeLine(line.text, line.number)
		if attr.err != nil {
			setChangeError(change, attr.line, attr.err)
			continue
		}
		if equalAttributeName(attr.name, "dn") || equalAttributeName(attr.name, "changetype") {
			continue
		}
		if isOperationName(attr.name) {
			opStart = i
			break
		}
		setChangeError(change, attr.line, fmt.Errorf("%w: unexpected line before an operation", ErrModifyStructure))
	}
	if opStart < 0 {
		setChangeError(change, change.Line, ErrEmptyModification)
		return
	}

	var current *Modification
	var currentLine int
	for i := opStart; i < len(record.lines); i++ {
		line := &record.lines[i]
		if isModifySeparator(line.text) {
			if current == nil {
				setChangeError(change, line.number, fmt.Errorf("%w: unexpected '-'", ErrModifyStructure))
				continue
			}
			change.Modifications = append(change.Modifications, *current)
			current = nil
			continue
		}

		attr := parseAttributeLine(line.text, line.number)
		if attr.err != nil {
			setChangeError(change, attr.line, attr.err)
			continue
		}

		if current == nil {
			operation, ok := operationFromName(attr.name)
			if !ok {
				setChangeError(change, attr.line, fmt.Errorf("%w: expected add, delete, or replace", ErrModifyStructure))
				continue
			}
			if len(attr.values) != 1 || strings.TrimSpace(attr.values[0]) == "" {
				setChangeError(change, attr.line, fmt.Errorf("%w: operation %s has no attribute name", ErrModifyStructure, operation))
				continue
			}
			current = &Modification{
				Operation: operation,
				Attribute: strings.TrimSpace(attr.values[0]),
			}
			currentLine = attr.line
			continue
		}

		if !equalAttributeName(attr.name, current.Attribute) {
			setChangeError(change, attr.line, fmt.Errorf(
				"%w: line %d has attribute %s, want %s or '-'",
				ErrModifyStructure, attr.line, attr.name, current.Attribute,
			))
			continue
		}
		current.Values = append(current.Values, attr.values...)
	}
	if current != nil {
		change.Modifications = append(change.Modifications, *current)
	}
	if len(change.Modifications) == 0 {
		setChangeError(change, currentLine, ErrEmptyModification)
	}
}

func setChangeError(change *Change, line int, err error) {
	if change == nil || change.Err != nil || err == nil {
		return
	}
	change.Err = &RecordError{Record: change.Record, Line: line, Err: err}
}

func isModifySeparator(text string) bool {
	return strings.TrimSpace(text) == "-"
}

func isOperationName(name string) bool {
	switch foldAttributeName(name) {
	case string(OperationAdd), string(OperationDelete), string(OperationReplace):
		return true
	default:
		return false
	}
}

func operationFromName(name string) (Operation, bool) {
	switch foldAttributeName(name) {
	case string(OperationAdd):
		return OperationAdd, true
	case string(OperationDelete):
		return OperationDelete, true
	case string(OperationReplace):
		return OperationReplace, true
	default:
		return "", false
	}
}

func containsValue(values []string, value string) bool {
	for _, existing := range values {
		if existing == value {
			return true
		}
	}
	return false
}

func foldAttributeName(name string) string {
	return strings.ToLower(name)
}
