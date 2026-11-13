package dataeng

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ValueKind identifies how a column value is represented.
type ValueKind uint8

const (
	// ValueNull is the zero value and represents SQL NULL.
	ValueNull ValueKind = iota
	// ValueText carries a textual representation of a value.
	ValueText
	// ValueBinary carries an opaque binary representation of a value.
	ValueBinary
	// ValueExternal is a reference to a large value whose chunks arrive later.
	ValueExternal
)

// ExternalID identifies an external (out-of-line) large value.
type ExternalID string

// Value is one tuple column value. Exactly the field matching Kind is used.
type Value struct {
	Kind  ValueKind
	Text  string
	Bytes []byte
	Ref   ExternalID
}

// NullValue returns a SQL NULL value.
func NullValue() Value { return Value{Kind: ValueNull} }

// TextValue returns a textual value.
func TextValue(text string) Value { return Value{Kind: ValueText, Text: text} }

// BinaryValue returns a binary value. The slice is copied.
func BinaryValue(data []byte) Value {
	return Value{Kind: ValueBinary, Bytes: append([]byte(nil), data...)}
}

// ExternalValue returns a placeholder for a large value that will be filled in
// by chunks.
func ExternalValue(id ExternalID) Value {
	return Value{Kind: ValueExternal, Ref: id}
}

// IsNull reports whether v is SQL NULL.
func (v Value) IsNull() bool { return v.Kind == ValueNull }

// IsExternal reports whether v is an unresolved external value.
func (v Value) IsExternal() bool { return v.Kind == ValueExternal }

// ErrInvalidValue reports a value that is inconsistent with its column type.
var ErrInvalidValue = errors.New("dataeng: invalid value")

func cloneValue(v Value) Value {
	v.Bytes = append([]byte(nil), v.Bytes...)
	return v
}

func valuesEqual(a, b Value) bool {
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case ValueNull:
		return true
	case ValueText:
		return a.Text == b.Text
	case ValueBinary:
		return bytes.Equal(a.Bytes, b.Bytes)
	case ValueExternal:
		return a.Ref == b.Ref
	default:
		return false
	}
}

func validateValue(v Value, col Column) error {
	if v.Kind == ValueNull || v.Kind == ValueBinary {
		return nil
	}
	if v.Kind == ValueExternal {
		if v.Ref == "" {
			return errorf(ErrInvalidValue, "column %q has an empty external identifier", col.Name)
		}
		return nil
	}
	if v.Kind != ValueText {
		return errorf(ErrInvalidValue, "column %q has unknown value kind %d", col.Name, v.Kind)
	}
	if err := validateText(col.Type, v.Text); err != nil {
		return errorf(ErrInvalidValue, "column %q (%s): %v", col.Name, col.Type, err)
	}
	return nil
}

var numericPattern = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`)
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validateText(typ ColumnType, text string) error {
	switch typ {
	case TypeBool:
		switch strings.ToLower(text) {
		case "t", "f", "true", "false", "1", "0":
			return nil
		default:
			return fmt.Errorf("expected a boolean")
		}
	case TypeInt2:
		_, err := strconv.ParseInt(text, 10, 16)
		if err != nil {
			return fmt.Errorf("expected a 16-bit integer")
		}
	case TypeInt4:
		_, err := strconv.ParseInt(text, 10, 32)
		if err != nil {
			return fmt.Errorf("expected a 32-bit integer")
		}
	case TypeInt8:
		_, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return fmt.Errorf("expected a 64-bit integer")
		}
	case TypeFloat4:
		_, err := strconv.ParseFloat(text, 32)
		if err != nil {
			return fmt.Errorf("expected a 32-bit floating point number")
		}
	case TypeFloat8:
		_, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return fmt.Errorf("expected a floating point number")
		}
	case TypeNumeric:
		if text != "NaN" && text != "Infinity" && text != "-Infinity" && !numericPattern.MatchString(text) {
			return fmt.Errorf("expected a numeric value")
		}
	case TypeText, TypeVarchar, TypeBytea:
		return nil
	case TypeDate:
		if _, err := time.Parse("2006-01-02", text); err != nil {
			return fmt.Errorf("expected a date")
		}
	case TypeTime:
		if _, err := time.Parse("15:04:05.999999999", text); err != nil {
			return fmt.Errorf("expected a time")
		}
	case TypeTimestamp, TypeTimestampTZ:
		if _, err := parseTimestamp(text); err != nil {
			return fmt.Errorf("expected a timestamp")
		}
	case TypeUUID:
		if !uuidPattern.MatchString(text) {
			return fmt.Errorf("expected a UUID")
		}
	case TypeJSON, TypeJSONB:
		if !json.Valid([]byte(text)) {
			return fmt.Errorf("expected valid JSON")
		}
	default:
		// Unknown types are opaque and accepted as text.
		return nil
	}
	return nil
}

func parseTimestamp(text string) (time.Time, error) {
	layouts := []string{
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999Z0700",
		"2006-01-02 15:04:05.999999999Z07",
		"2006-01-02 15:04:05.999999999",
		time.RFC3339Nano,
	}
	var lastErr error
	for _, layout := range layouts {
		t, err := time.Parse(layout, text)
		if err == nil {
			return t, nil
		}
		lastErr = err
	}
	return time.Time{}, lastErr
}
