package dataeng

import "fmt"

// FieldType classifies the physical encoding of a field.
type FieldType int

const (
	// FieldString is a blank-padded EBCDIC character field.
	FieldString FieldType = iota
	// FieldPackedDecimal is a signed packed decimal (COMP-3) field.
	FieldPackedDecimal
	// FieldZonedDecimal is a zoned decimal field with an overpunch sign
	// in the last byte.
	FieldZonedDecimal
)

// Field describes one field inside a fixed-width record. Offset and Length
// are always byte counts, never character counts.
type Field struct {
	Name     string
	Offset   int // byte offset within the record
	Length   int // byte length
	Type     FieldType
	Scale    int  // implied decimal places for decimal fields
	Nullable bool // an all-blank (or all-zero packed) value decodes to nil
}

// Discriminator selects a schema version by matching a decoded field value.
type Discriminator struct {
	Offset int // byte offset of the version field
	Length int // byte length of the version field
	Values []string
}

// Schema describes one record layout version.
type Schema struct {
	Name          string
	Version       string
	RecordLength  int
	CodePage      CodePage
	Discriminator *Discriminator // optional version discriminator
	Fields        []Field
}

func (s *Schema) validate() error {
	if s.RecordLength <= 0 {
		return fmt.Errorf("dataeng: schema %q: record length must be positive", s.Name)
	}
	if _, err := s.CodePage.table(); err != nil {
		return fmt.Errorf("dataeng: schema %q: %w", s.Name, err)
	}
	if d := s.Discriminator; d != nil {
		if d.Offset < 0 || d.Length <= 0 || d.Offset+d.Length > s.RecordLength {
			return fmt.Errorf("dataeng: schema %q: discriminator out of record bounds", s.Name)
		}
		if len(d.Values) == 0 {
			return fmt.Errorf("dataeng: schema %q: discriminator has no values", s.Name)
		}
	}
	for _, f := range s.Fields {
		if f.Name == "" {
			return fmt.Errorf("dataeng: schema %q: field with empty name", s.Name)
		}
		if f.Offset < 0 || f.Length <= 0 || f.Offset+f.Length > s.RecordLength {
			return fmt.Errorf("dataeng: schema %q: field %q out of record bounds", s.Name, f.Name)
		}
		if f.Type == FieldPackedDecimal && f.Length < 1 {
			return fmt.Errorf("dataeng: schema %q: field %q: packed decimal needs at least 1 byte", s.Name, f.Name)
		}
	}
	return nil
}

// Registry selects a schema for a raw record from its byte length, the
// EBCDIC code page, and an optional version discriminator field.
type Registry struct {
	schemas []*Schema
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{} }

// Register validates and adds a schema.
func (r *Registry) Register(s *Schema) error {
	if err := s.validate(); err != nil {
		return err
	}
	r.schemas = append(r.schemas, s)
	return nil
}

// Match picks the schema for a raw record. Candidates are filtered by exact
// record byte length and code page; discriminator values are then compared
// against the decoded discriminator field. A schema without a discriminator
// acts as the fallback for its (length, code page) pair.
func (r *Registry) Match(raw []byte, cp CodePage) (*Schema, error) {
	var fallback *Schema
	matched := false
	for _, s := range r.schemas {
		if s.RecordLength != len(raw) || s.CodePage != cp {
			continue
		}
		if s.Discriminator == nil {
			if fallback != nil && fallback != s {
				return nil, fmt.Errorf("dataeng: ambiguous schemas %q and %q for length %d",
					fallback.Name, s.Name, len(raw))
			}
			fallback = s
			continue
		}
		d := s.Discriminator
		text, err := cp.DecodeField(raw[d.Offset : d.Offset+d.Length])
		if err != nil {
			return nil, err
		}
		for _, v := range d.Values {
			if text == v {
				if matched {
					return nil, fmt.Errorf("dataeng: ambiguous discriminator match for length %d", len(raw))
				}
				matched = true
				fallback = s
			}
		}
	}
	if fallback == nil {
		return nil, fmt.Errorf("dataeng: no schema for record length %d and code page %d", len(raw), int(cp))
	}
	return fallback, nil
}
