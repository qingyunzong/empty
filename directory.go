package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// Key identifies a version of a shared dictionary. Names must be non-empty
// and versions must be positive integers.
type Key struct {
	Name    string
	Version uint64
}

// DictionaryKey is an alias for Key.
type DictionaryKey = Key

// Slot is one entry of a shared dictionary. Known is false for a slot whose
// text has not been downloaded. A Known slot may carry an empty string.
type Slot struct {
	Text  string
	Known bool
}

// KnownSlot returns a downloaded slot. Empty text is a valid, known value.
func KnownSlot(text string) Slot { return Slot{Text: text, Known: true} }

// UnknownSlot returns an undownloaded slot.
func UnknownSlot() Slot { return Slot{} }

// Unknown is a marker used in []Unknown literals to describe a table whose
// slots are all unknown. []Unknown only stores the length. For very large
// unknown tables use UnknownSlots or UnknownTable.
type Unknown struct{}

// UnknownSlotMarker is an alias for Unknown.
type UnknownSlotMarker = Unknown

// UnknownSlots describes a table consisting of n unknown slots without
// allocating an array of that length.
type UnknownSlots uint64

// Table is an immutable description of one shared-dictionary version.
//
// Slots contains the slots that actually exist in the directory array.
// UnknownLength describes additional unknown slots after Slots. This lets a
// table of enormous length occupy only interval metadata. A Table may also be
// all known or contain a mixture of Known and unknown slots.
type Table struct {
	Slots         []Slot
	UnknownLength uint64
}

// Len returns the number of slots described by t. Callers constructing very
// large tables should use NewContext's validation to detect uint64 overflow.
func (t Table) Len() uint64 {
	return uint64(len(t.Slots)) + t.UnknownLength
}

func (t Table) checkedLen() (uint64, error) {
	n := uint64(len(t.Slots))
	if t.UnknownLength > math.MaxUint64-n {
		return 0, fmt.Errorf("%w: table length", ErrSIDOverflow)
	}
	return n + t.UnknownLength, nil
}

// SlotAt returns the slot at a one-based position. The second result is false
// when position is outside the table. A padding position is reported as an
// unknown slot.
func (t Table) SlotAt(oneBased uint64) (Slot, bool) {
	if oneBased == 0 {
		return Slot{}, false
	}
	if oneBased <= uint64(len(t.Slots)) {
		return t.Slots[oneBased-1], true
	}
	if oneBased <= t.Len() {
		return Slot{}, true
	}
	return Slot{}, false
}

// TextTable builds a fully known table from texts.
func TextTable(texts []string) Table {
	table := Table{Slots: make([]Slot, len(texts))}
	for i, text := range texts {
		table.Slots[i] = KnownSlot(text)
	}
	return table
}

// NewStringTable is an alias for TextTable.
func NewStringTable(texts []string) Table { return TextTable(texts) }

// TextTableValues builds a fully known table from variadic texts.
func TextTableValues(texts ...string) Table { return TextTable(texts) }

// SlotsTable builds a table from an explicit slot array.
func SlotsTable(slots []Slot) Table { return Table{Slots: slots} }

// UnknownTable builds an all-unknown table of the given length without
// allocating any slot array.
func UnknownTable(length uint64) Table {
	return Table{UnknownLength: length}
}

// Directory is the immutable dictionary supplied by the host.
//
// Keys are table names and positive versions. Values may be any of:
//
//   - Table
//   - *Table
//   - []Slot
//   - []string
//   - string (one known slot)
//   - []Unknown / []UnknownSlotMarker (all unknown, length is array length)
//   - UnknownSlots (all unknown, length is the numeric value)
//   - nil (a zero-length table)
//
// The host must not mutate a Directory after it has been passed to
// NewContext. NewContext snapshots the entries it uses, so replacing map
// entries later does not change an existing Context.
type Directory map[Key]any

// Dictionary is an alias for Directory.
type Dictionary = Directory

// NewDirectory returns an empty mutable directory builder map.
func NewDirectory() Directory { return make(Directory) }

// Put adds an entry after validating its key and value type.
func (d Directory) Put(name string, version uint64, value any) error {
	if d == nil {
		return errors.New("dataeng: cannot put into a nil Directory")
	}
	if err := validateKey(Key{Name: name, Version: version}); err != nil {
		return err
	}
	if err := validateTableValue(value); err != nil {
		return err
	}
	d[Key{Name: name, Version: version}] = value
	return nil
}

// Validate checks all keys and value types without expanding unknown
// interval metadata.
func (d Directory) Validate() error {
	for key, value := range d {
		if err := validateKey(key); err != nil {
			return err
		}
		if err := validateTableValue(value); err != nil {
			return fmt.Errorf("dataeng: directory %q version %d: %w", key.Name, key.Version, err)
		}
	}
	return nil
}

func validateKey(key Key) error {
	if key.Name == "" {
		return errors.New("dataeng: dictionary name must be non-empty")
	}
	if key.Version == 0 {
		return errors.New("dataeng: dictionary version must be positive")
	}
	return nil
}

// validateTableValue checks a Directory value without materializing slots.
func validateTableValue(value any) error {
	switch v := value.(type) {
	case nil:
		return nil
	case Table:
		_, err := v.checkedLen()
		return err
	case *Table:
		if v == nil {
			return errors.New("dataeng: nil *Table directory value")
		}
		_, err := v.checkedLen()
		return err
	case []Slot:
		return nil
	case []string:
		return nil
	case string:
		return nil
	case UnknownSlots:
		return nil
	case []Unknown:
		return nil
	default:
		return fmt.Errorf("dataeng: unsupported directory value type %T", value)
	}
}

// inspectTableValue converts a validated Directory value. It does not clone
// Table.Slots.
func inspectTableValue(value any) (Table, error) {
	if err := validateTableValue(value); err != nil {
		return Table{}, err
	}
	switch v := value.(type) {
	case nil:
		return Table{}, nil
	case Table:
		return v, nil
	case *Table:
		return *v, nil
	case []Slot:
		return Table{Slots: v}, nil
	case []string:
		return TextTable(v), nil
	case string:
		return Table{Slots: []Slot{KnownSlot(v)}}, nil
	case UnknownSlots:
		return Table{UnknownLength: uint64(v)}, nil
	case []Unknown:
		return Table{UnknownLength: uint64(len(v))}, nil
	default:
		// Unreachable after validateTableValue.
		return Table{}, fmt.Errorf("dataeng: unsupported directory value type %T", value)
	}
}

func normalizeTableValue(value any) (Table, error) {
	table, err := inspectTableValue(value)
	if err != nil {
		return Table{}, err
	}
	if len(table.Slots) != 0 {
		table.Slots = append([]Slot(nil), table.Slots...)
	}
	return table, nil
}

// Exact returns the table at name/version, if present.
func (d Directory) Exact(name string, version uint64) (Table, bool, error) {
	if err := validateKey(Key{Name: name, Version: version}); err != nil {
		return Table{}, false, err
	}
	value, ok := d[Key{Name: name, Version: version}]
	if !ok {
		return Table{}, false, nil
	}
	table, err := normalizeTableValue(value)
	return table, true, err
}

// Highest returns the highest version of name in the directory.
func (d Directory) Highest(name string) (uint64, Table, bool, error) {
	if name == "" {
		return 0, Table{}, false, errors.New("dataeng: dictionary name must be non-empty")
	}
	var bestVersion uint64
	var bestValue any
	var found bool
	for key, value := range d {
		if key.Name != name {
			continue
		}
		if key.Version == 0 {
			return 0, Table{}, false, fmt.Errorf("dataeng: dictionary %q has invalid version 0", name)
		}
		if !found || key.Version > bestVersion {
			bestVersion = key.Version
			bestValue = value
			found = true
		}
	}
	if !found {
		return 0, Table{}, false, nil
	}
	table, err := normalizeTableValue(bestValue)
	if err != nil {
		return 0, Table{}, false, fmt.Errorf("dataeng: directory %q version %d: %w", name, bestVersion, err)
	}
	return bestVersion, table, true, nil
}
