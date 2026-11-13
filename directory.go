package dataeng

import (
	"fmt"
	"sort"
	"strings"
)

// Entry is an entry in an in-memory directory. Attributes is keyed by the
// case-folded attribute name. Values preserve their order and are compared
// byte for byte.
type Entry struct {
	DN         string
	Attributes map[string][]string
}

// Get returns the values of name. Attribute names are case-insensitive.
func (e *Entry) Get(name string) ([]string, bool) {
	if e == nil {
		return nil, false
	}
	values, ok := e.Attributes[foldAttributeName(name)]
	if !ok {
		return nil, false
	}
	return append([]string(nil), values...), true
}

// Names returns the case-folded attribute names in sorted order.
func (e *Entry) Names() []string {
	if e == nil {
		return nil
	}
	names := make([]string, 0, len(e.Attributes))
	for name := range e.Attributes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (e *Entry) clone() *Entry {
	if e == nil {
		return nil
	}
	return &Entry{DN: e.DN, Attributes: cloneAttributes(e.Attributes)}
}

// Directory is an in-memory directory built from change records. DNs are
// compared with the normalization function supplied by the caller.
type Directory struct {
	normalizeDN func(string) string
	entries     map[string]*Entry
}

// NewDirectory returns an empty directory. normalizeDN is used for every DN
// comparison; nil means that DNs are compared exactly as written.
func NewDirectory(normalizeDN func(string) string) *Directory {
	if normalizeDN == nil {
		normalizeDN = func(dn string) string { return dn }
	}
	return &Directory{
		normalizeDN: normalizeDN,
		entries:     make(map[string]*Entry),
	}
}

// Key returns the key used to compare dn. It is exported so callers can check
// that their normalizer behaves as expected.
func (d *Directory) Key(dn string) string {
	if d == nil || d.normalizeDN == nil {
		return dn
	}
	return d.normalizeDN(dn)
}

// Lookup returns a copy of the entry for dn.
func (d *Directory) Lookup(dn string) (*Entry, bool) {
	if d == nil {
		return nil, false
	}
	entry, ok := d.entries[d.Key(dn)]
	if !ok {
		return nil, false
	}
	return entry.clone(), true
}

// Len returns the number of entries.
func (d *Directory) Len() int {
	if d == nil {
		return 0
	}
	return len(d.entries)
}

// Entries returns copies of all entries sorted by normalized DN.
func (d *Directory) Entries() []*Entry {
	if d == nil {
		return nil
	}
	keys := make([]string, 0, len(d.entries))
	for key := range d.entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	entries := make([]*Entry, 0, len(keys))
	for _, key := range keys {
		entries = append(entries, d.entries[key].clone())
	}
	return entries
}

// Clone returns an independent copy of the directory.
func (d *Directory) Clone() *Directory {
	if d == nil {
		return nil
	}
	clone := NewDirectory(d.normalizeDN)
	for key, entry := range d.entries {
		clone.entries[key] = entry.clone()
	}
	return clone
}

// Apply applies one change to the directory. Applying a record is atomic: if
// any operation fails, the directory is left unchanged and the returned error
// describes the failure.
func (d *Directory) Apply(change *Change) error {
	if d == nil {
		return fmt.Errorf("nil directory")
	}
	if change == nil {
		return fmt.Errorf("nil change")
	}
	if change.Err != nil {
		return change.Err
	}
	if d.entries == nil {
		d.entries = make(map[string]*Entry)
	}
	if d.normalizeDN == nil {
		d.normalizeDN = func(dn string) string { return dn }
	}

	key := d.Key(change.DN)
	switch change.Type {
	case ChangeAdd:
		return d.applyAdd(key, change)
	case ChangeModify:
		return d.applyModify(key, change)
	case ChangeDelete:
		if _, ok := d.entries[key]; !ok {
			return fmt.Errorf("%w: %s", ErrEntryNotFound, change.DN)
		}
		delete(d.entries, key)
		return nil
	default:
		return fmt.Errorf("%w: %q", ErrInvalidChangeType, change.Type)
	}
}

func (d *Directory) applyAdd(key string, change *Change) error {
	if _, ok := d.entries[key]; ok {
		return fmt.Errorf("%w: %s", ErrEntryExists, change.DN)
	}

	attributes := make(map[string][]string, len(change.Attributes))
	for _, attribute := range change.Attributes {
		if strings.TrimSpace(attribute.Name) == "" {
			return fmt.Errorf("%w: empty attribute name", ErrInvalidAttribute)
		}
		name := foldAttributeName(attribute.Name)
		values := attributes[name]
		for _, value := range attribute.Values {
			if containsValue(values, value) {
				return fmt.Errorf("%w: attribute %s value %q", ErrDuplicateValue, attribute.Name, value)
			}
			values = append(values, value)
		}
		attributes[name] = values
	}

	d.entries[key] = &Entry{DN: change.DN, Attributes: attributes}
	return nil
}

func (d *Directory) applyModify(key string, change *Change) error {
	entry, ok := d.entries[key]
	if !ok {
		return fmt.Errorf("%w: %s", ErrEntryNotFound, change.DN)
	}

	attributes := cloneAttributes(entry.Attributes)
	for _, modification := range change.Modifications {
		if err := applyModification(attributes, modification); err != nil {
			return fmt.Errorf("modify %s: %w", change.DN, err)
		}
	}

	entry.Attributes = attributes
	return nil
}

func applyModification(attributes map[string][]string, modification Modification) error {
	if strings.TrimSpace(modification.Attribute) == "" {
		return fmt.Errorf("%w: empty attribute name", ErrInvalidAttribute)
	}
	name := foldAttributeName(modification.Attribute)

	switch modification.Operation {
	case OperationAdd:
		if len(modification.Values) == 0 {
			return fmt.Errorf("%w: add %s has no values", ErrInvalidAttribute, modification.Attribute)
		}
		values := attributes[name]
		for _, value := range modification.Values {
			if containsValue(values, value) {
				return fmt.Errorf("%w: %s value %q", ErrValueExists, modification.Attribute, value)
			}
			values = append(values, value)
		}
		attributes[name] = values
		return nil

	case OperationDelete:
		values, ok := attributes[name]
		if !ok {
			return fmt.Errorf("%w: %s", ErrAttributeNotFound, modification.Attribute)
		}
		if len(modification.Values) == 0 {
			delete(attributes, name)
			return nil
		}
		for _, value := range modification.Values {
			index := valueIndex(values, value)
			if index < 0 {
				return fmt.Errorf("%w: %s value %q", ErrValueNotFound, modification.Attribute, value)
			}
			values = append(values[:index], values[index+1:]...)
		}
		if len(values) == 0 {
			delete(attributes, name)
		} else {
			attributes[name] = values
		}
		return nil

	case OperationReplace:
		if len(modification.Values) == 0 {
			delete(attributes, name)
			return nil
		}
		values := make([]string, 0, len(modification.Values))
		for _, value := range modification.Values {
			if containsValue(values, value) {
				return fmt.Errorf("%w: %s value %q", ErrDuplicateValue, modification.Attribute, value)
			}
			values = append(values, value)
		}
		attributes[name] = values
		return nil

	default:
		return fmt.Errorf("%w: unknown operation %q", ErrModifyStructure, modification.Operation)
	}
}

func cloneAttributes(attributes map[string][]string) map[string][]string {
	clone := make(map[string][]string, len(attributes))
	for name, values := range attributes {
		clone[name] = append([]string(nil), values...)
	}
	return clone
}

func valueIndex(values []string, value string) int {
	for i := range values {
		if values[i] == value {
			return i
		}
	}
	return -1
}
