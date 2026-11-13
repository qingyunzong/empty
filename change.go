package dataeng

import (
	"errors"
	"fmt"
)

// ChangeType is the changetype of an LDIF change record.
type ChangeType string

const (
	ChangeAdd    ChangeType = "add"
	ChangeModify ChangeType = "modify"
	ChangeDelete ChangeType = "delete"
)

// Short aliases for the change types.
const (
	Add    = ChangeAdd
	Modify = ChangeModify
	Delete = ChangeDelete
)

// Operation is an operation inside a modify change record.
type Operation string

const (
	OperationAdd     Operation = "add"
	OperationDelete  Operation = "delete"
	OperationReplace Operation = "replace"
)

// Short aliases for the modify operations.
const (
	OpAdd     = OperationAdd
	OpDelete  = OperationDelete
	OpReplace = OperationReplace
)

// Attribute is a name and its values. Attribute names are case-insensitive,
// while values are compared byte for byte.
type Attribute struct {
	Name   string
	Values []string
}

// Modification is one operation of a modify change record. Values are applied
// in order by Directory.Apply.
type Modification struct {
	Operation Operation
	Attribute string
	Values    []string
}

// Attr and Mod are aliases for Attribute and Modification.
type Attr = Attribute
type Mod = Modification

// Change is one logical change record. For add records the entry attributes
// are in Attributes. For modify records the ordered operations are in
// Modifications. An add or modify record never has both populated.
//
// Err is set when the record is malformed or, for ReadChanges, when applying
// the record to the directory fails. A bad record is returned in place and
// parsing continues with the following record.
type Change struct {
	Record        int
	Line          int
	DN            string
	Type          ChangeType
	Attributes    []Attribute
	Modifications []Modification
	Err           error
}

// OK reports whether the record is free of parsing and application errors.
func (c *Change) OK() bool {
	return c != nil && c.Err == nil
}

// Values returns the values of the named attribute in an add record. Attribute
// names are matched case-insensitively.
func (c *Change) Values(name string) ([]string, bool) {
	if c == nil {
		return nil, false
	}
	for i := range c.Attributes {
		if equalAttributeName(c.Attributes[i].Name, name) {
			return append([]string(nil), c.Attributes[i].Values...), true
		}
	}
	return nil, false
}

// RecordError identifies a bad record by its one-based record number and the
// one-based physical line where the record starts.
type RecordError struct {
	Record int
	Line   int
	Err    error
}

func (e *RecordError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("record %d (line %d): %v", e.Record, e.Line, e.Err)
	}
	return fmt.Sprintf("record %d: %v", e.Record, e.Err)
}

func (e *RecordError) Unwrap() error {
	return e.Err
}

// Sentinel errors used with errors.Is.
var (
	ErrMissingDN            = errors.New("missing dn")
	ErrInvalidChangeType    = errors.New("invalid changetype")
	ErrInvalidAttribute     = errors.New("invalid attribute")
	ErrInvalidBase64        = errors.New("invalid base64 value")
	ErrContinuation         = errors.New("continuation line without a preceding line")
	ErrModifyStructure      = errors.New("invalid modify operation sequence")
	ErrEmptyModification    = errors.New("modify record has no operations")
	ErrEntryExists          = errors.New("entry already exists")
	ErrEntryNotFound        = errors.New("entry does not exist")
	ErrAttributeNotFound    = errors.New("attribute does not exist")
	ErrValueExists          = errors.New("value already exists")
	ErrValueNotFound        = errors.New("value does not exist")
	ErrDuplicateValue       = errors.New("duplicate value")
	ErrDeleteWithAttributes = errors.New("delete record has unexpected attributes")
)

func equalAttributeName(a, b string) bool {
	return foldAttributeName(a) == foldAttributeName(b)
}
