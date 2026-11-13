package dataeng

import (
	"errors"
	"fmt"
	"math"
)

var (
	// ErrSIDOverflow reports that assigning the requested slots would require
	// a SID greater than math.MaxUint64.
	ErrSIDOverflow = errors.New("dataeng: symbol SID space overflow")
	// ErrSIDOutOfRange reports a SID greater than the Context's current
	// maximum. Such a SID is never treated as an unknown slot.
	ErrSIDOutOfRange = errors.New("dataeng: symbol SID out of range")
	// ErrImportNotFound reports an import without maxID whose exact table
	// version is absent from the directory.
	ErrImportNotFound = errors.New("dataeng: exact shared dictionary version not found")
	// ErrNilContext reports use of a nil Context.
	ErrNilContext = errors.New("dataeng: nil Context")
)

// Import describes one shared-dictionary import. MaxID is optional: when nil,
// the import takes the exact table's length. When non-nil, the area length is
// exactly *MaxID, including the meaningful value 0.
//
// Resolution order is:
//   - the exact Name/Version table when present;
//   - otherwise, if MaxID is present, the highest version with the same Name;
//   - otherwise (including a name absent from the directory) all slots are
//     unknown, or the import is rejected when MaxID is nil.
type Import struct {
	Name    string
	Version uint64
	MaxID   *uint64
}

// ImportWithMax returns an Import with an explicit maxID.
func ImportWithMax(name string, version, maxID uint64) Import {
	return Import{Name: name, Version: version, MaxID: &maxID}
}

// MaxIDValue returns a pointer to a copy of maxID, for use in Import literals.
func MaxIDValue(maxID uint64) *uint64 {
	value := maxID
	return &value
}

type importArea struct {
	name    string
	version uint64
	start   uint64 // first SID; zero when length is zero
	length  uint64 // visible length, independent of table array length
	table   Table
}

func (a importArea) tokenAt(offset uint64) Token {
	if offset <= uint64(len(a.table.Slots)) {
		slot := a.table.Slots[offset-1]
		if slot.Known {
			return Known(slot.Text)
		}
	}
	// Positions beyond the directory array, as well as explicit unknown
	// slots, are shared-unknown identities. No padding array is materialized.
	return SharedUnknown(a.name, offset)
}

func (a importArea) isUnknownAt(offset uint64) bool {
	if offset <= uint64(len(a.table.Slots)) {
		return !a.table.Slots[offset-1].Known
	}
	return offset <= a.length
}

// Context is an immutable snapshot of a system dictionary, an ordered set of
// shared imports, and local known slots. SIDs are assigned sequentially from
// 1. SID 0 is LocalUnknown.
//
// Methods never mutate the receiver. AppendLocal and Reset return new
// snapshots, so tokens and snapshots obtained earlier remain valid.
type Context struct {
	system      []string
	imports     []importArea
	local       []string
	prefixTotal uint64 // maximum SID of system plus imports
	maxSID      uint64
}

// NewContext builds a context from the fixed system dictionary, the ordered
// shared imports, and the host directory. It replaces any previous context;
// the previous snapshot is not modified.
func NewContext(system []string, imports []Import, directory Directory) (*Context, error) {
	if err := directory.Validate(); err != nil {
		return nil, err
	}

	systemCopy := append([]string(nil), system...)
	context := &Context{
		system: systemCopy,
	}
	total := uint64(len(systemCopy))
	context.imports = make([]importArea, 0, len(imports))

	for index, spec := range imports {
		area, err := makeImportArea(spec, directory)
		if err != nil {
			return nil, fmt.Errorf("dataeng: import %d (%q version %d): %w",
				index, spec.Name, spec.Version, err)
		}
		if area.length > math.MaxUint64-total {
			return nil, fmt.Errorf("%w: system and imports exceed uint64 SID space", ErrSIDOverflow)
		}
		if area.length != 0 {
			area.start = total + 1
			total += area.length
		}
		context.imports = append(context.imports, area)
	}

	context.prefixTotal = total
	context.maxSID = total
	return context, nil
}

func makeImportArea(spec Import, directory Directory) (importArea, error) {
	if spec.Name == "" {
		return importArea{}, errors.New("dictionary name must be non-empty")
	}
	if spec.Version == 0 {
		return importArea{}, errors.New("dictionary version must be positive")
	}

	area := importArea{
		name:    spec.Name,
		version: spec.Version,
	}

	exact, found, err := directory.Exact(spec.Name, spec.Version)
	if err != nil {
		return importArea{}, err
	}
	if found {
		area.table = exact
		if spec.MaxID == nil {
			length, err := exact.checkedLen()
			if err != nil {
				return importArea{}, err
			}
			area.length = length
		} else {
			area.length = *spec.MaxID
		}
		return area, nil
	}

	if spec.MaxID == nil {
		return importArea{}, ErrImportNotFound
	}

	_, fallback, hasFallback, err := directory.Highest(spec.Name)
	if err != nil {
		return importArea{}, err
	}
	if hasFallback {
		area.table = fallback
	}
	area.length = *spec.MaxID
	return area, nil
}

// MaxSID returns the largest SID currently resolvable by c. SID 0 remains the
// local unknown identity.
func (c *Context) MaxSID() uint64 {
	if c == nil {
		return 0
	}
	return c.maxSID
}

// SystemLen returns the number of fixed system slots.
func (c *Context) SystemLen() uint64 {
	if c == nil {
		return 0
	}
	return uint64(len(c.system))
}

// LocalLen returns the number of local known slots.
func (c *Context) LocalLen() int {
	if c == nil {
		return 0
	}
	return len(c.local)
}

// ImportLen returns the number of shared import areas, including zero-length
// areas.
func (c *Context) ImportLen() int {
	if c == nil {
		return 0
	}
	return len(c.imports)
}

// Resolve maps a SID to its immutable token. SID 0 is LocalUnknown. A SID
// greater than MaxSID is an error and is never synthesized as an unknown
// slot.
func (c *Context) Resolve(sid uint64) (Token, error) {
	if c == nil {
		return Token{}, ErrNilContext
	}
	if sid == 0 {
		return LocalUnknown(), nil
	}
	if sid > c.maxSID {
		return Token{}, fmt.Errorf("%w: SID %d, maximum %d", ErrSIDOutOfRange, sid, c.maxSID)
	}

	if sid <= uint64(len(c.system)) {
		return Known(c.system[sid-1]), nil
	}

	for _, area := range c.imports {
		if area.length == 0 || sid < area.start {
			continue
		}
		if offset := sid - area.start; offset < area.length {
			return area.tokenAt(offset + 1), nil
		}
	}

	if sid > c.prefixTotal {
		index := sid - c.prefixTotal - 1
		if index < uint64(len(c.local)) {
			return Known(c.local[index]), nil
		}
	}

	// Validation above guarantees that this is unreachable for a consistent
	// snapshot.
	return Token{}, fmt.Errorf("%w: SID %d", ErrSIDOutOfRange, sid)
}

// TokenAt is an alias for Resolve.
func (c *Context) TokenAt(sid uint64) (Token, error) { return c.Resolve(sid) }

// Lookup finds the smallest SID in the current snapshot whose token is
// Equivalent to token. Known text search covers the system area, every
// visible import slot in import order, then local slots. Shared unknown
// search covers only imports that currently present that unknown identity;
// a known slot with a coincidentally equal numeric SID is never substituted.
// LocalUnknown always maps to SID 0.
func (c *Context) Lookup(token Token) (uint64, bool) {
	if c == nil {
		return 0, false
	}
	switch token.Kind {
	case KnownKind:
		return c.lookupKnown(token.Text)
	case LocalUnknownKind:
		return 0, true
	case SharedUnknownKind:
		if token.Name == "" || token.Ordinal == 0 {
			return 0, false
		}
		for _, area := range c.imports {
			if area.name != token.Name || area.length == 0 {
				continue
			}
			if token.Ordinal > area.length {
				continue
			}
			if area.isUnknownAt(token.Ordinal) {
				return area.start + token.Ordinal - 1, true
			}
		}
		return 0, false
	default:
		return 0, false
	}
}

// Find is an alias for Lookup.
func (c *Context) Find(token Token) (uint64, bool) { return c.Lookup(token) }

func (c *Context) lookupKnown(text string) (uint64, bool) {
	for index, systemText := range c.system {
		if systemText == text {
			return uint64(index) + 1, true
		}
	}

	for _, area := range c.imports {
		visible := uint64(len(area.table.Slots))
		if area.length < visible {
			visible = area.length
		}
		for index := uint64(0); index < visible; index++ {
			slot := area.table.Slots[index]
			if slot.Known && slot.Text == text {
				return area.start + index, true
			}
		}
	}

	for index, localText := range c.local {
		if localText == text {
			return c.prefixTotal + uint64(index) + 1, true
		}
	}
	return 0, false
}

// AppendLocal returns a new snapshot with texts appended as local known
// slots. All previous SIDs, imports and local slots are preserved. If adding
// texts would overflow the SID space, the receiver is unchanged and an error
// is returned.
func (c *Context) AppendLocal(texts ...string) (*Context, error) {
	if c == nil {
		return nil, ErrNilContext
	}
	added := uint64(len(texts))
	if added > math.MaxUint64-c.maxSID {
		return nil, fmt.Errorf("%w: cannot append %d local slots at SID %d",
			ErrSIDOverflow, added, c.maxSID)
	}

	local := make([]string, len(c.local), len(c.local)+len(texts))
	copy(local, c.local)
	local = append(local, texts...)

	snapshot := *c
	snapshot.local = local
	snapshot.maxSID = c.maxSID + added
	return &snapshot, nil
}

// Reset returns a new snapshot containing only the system area. Old
// snapshots, old tokens and old imported unknown identities remain usable as
// immutable values, but they are not resolvable through the reset snapshot.
func (c *Context) Reset() *Context {
	if c == nil {
		return nil
	}
	return &Context{
		system:      c.system,
		prefixTotal: uint64(len(c.system)),
		maxSID:      uint64(len(c.system)),
	}
}
