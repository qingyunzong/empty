// Package wasmcheck inspects WebAssembly version 1 binaries for a plugin
// host. It validates the type, import, function, table, export and element
// sections against a caller-supplied import allowlist, while every other
// standard section is only checked for ordering and declared length.
//
// The accepted surface is intentionally narrow: only function imports,
// funcref tables and active element segments are allowed. Any other import
// kind, table type or element form is rejected. On success Inspect and Load
// return a read-only Capabilities summary; Load only invokes the
// instantiation callback after every check has passed.
package wasmcheck

import (
	"errors"
	"fmt"
)

// sectionRank gives the canonical order in which standard sections must
// appear. Custom sections are excluded and may occur anywhere, repeatedly.
var sectionRank = map[byte]int{
	sectionType:      1,
	sectionImport:    2,
	sectionFunction:  3,
	sectionTable:     4,
	sectionMemory:    5,
	sectionGlobal:    6,
	sectionExport:    7,
	sectionStart:     8,
	sectionElement:   9,
	sectionDataCount: 10,
	sectionCode:      11,
	sectionData:      12,
}

type importKey struct {
	module string
	field  string
}

type state struct {
	types         []FuncType
	imports       []Import
	definedFuncs  []uint32
	tables        []Table
	exports       []Export
	elements      []ElementSegment
	importedFuncs uint32
	lastRank      int
}

// Inspect parses and validates a WebAssembly version 1 binary. allowed lists
// every import the host is willing to provide; the module may use a subset
// but each of its imports must match an entry by module name, field name and
// exact function type. The returned Capabilities value is read-only.
func Inspect(binary []byte, allowed []AllowedImport) (*Capabilities, error) {
	allow := make(map[importKey]FuncType, len(allowed))
	for _, a := range allowed {
		if a.Module == "" || a.Field == "" {
			return nil, errors.New("wasmcheck: allowed import has empty module or field name")
		}
		allow[importKey{module: a.Module, field: a.Field}] = a.FuncType
	}

	root := &reader{buf: binary}
	if root.remaining() < 8 {
		return nil, errors.New("wasmcheck: truncated module header")
	}
	if string(root.buf[0:4]) != wasmMagic {
		return nil, errors.New("wasmcheck: invalid WebAssembly magic number")
	}
	root.pos = 4
	// The version is a fixed 4-byte little-endian integer, not LEB128.
	version := uint32(root.buf[4]) | uint32(root.buf[5])<<8 |
		uint32(root.buf[6])<<16 | uint32(root.buf[7])<<24
	root.pos = 8
	if version != wasmVersion {
		return nil, fmt.Errorf("wasmcheck: unsupported binary version %d, only version 1 is supported", version)
	}

	st := &state{lastRank: 0}
	for root.remaining() > 0 {
		id, err := root.readByte()
		if err != nil {
			return nil, errUnexpectedEOF
		}
		size, err := root.u32()
		if err != nil {
			return nil, fmt.Errorf("wasmcheck: section %d length: %w", id, err)
		}
		if uint64(size) > uint64(root.remaining()) {
			return nil, fmt.Errorf("wasmcheck: section %d length %d exceeds remaining module bytes", id, size)
		}
		sec := &reader{buf: root.buf[root.pos : root.pos+int(size)]}
		root.pos += int(size)

		if id == sectionCustom {
			if err := checkCustom(sec); err != nil {
				return nil, fmt.Errorf("wasmcheck: custom section: %w", err)
			}
			continue
		}

		rank, known := sectionRank[id]
		if !known {
			return nil, fmt.Errorf("wasmcheck: unknown standard section id %d", id)
		}
		if rank <= st.lastRank {
			return nil, fmt.Errorf("wasmcheck: section id %d is duplicated or out of order", id)
		}
		st.lastRank = rank

		parsed := true
		switch id {
		case sectionType:
			err = st.parseTypes(sec)
		case sectionImport:
			err = st.parseImports(sec, allow)
		case sectionFunction:
			err = st.parseFunctions(sec)
		case sectionTable:
			err = st.parseTables(sec)
		case sectionExport:
			err = st.parseExports(sec)
		case sectionElement:
			err = st.parseElements(sec)
		default:
			// Memory, global, start, code, data and data count sections:
			// only ordering and declared length are enforced.
			parsed = false
			err = nil
		}
		if err != nil {
			return nil, fmt.Errorf("wasmcheck: section %d: %w", id, err)
		}
		if parsed && sec.remaining() != 0 {
			return nil, fmt.Errorf("wasmcheck: section %d has %d trailing byte(s)", id, sec.remaining())
		}
	}

	return st.capabilities(), nil
}

// InstantiateFunc is invoked by Load only after the binary passes every
// check. It receives the same read-only capabilities handed to the caller.
type InstantiateFunc func(caps *Capabilities) error

// Load inspects binary and invokes instantiate on success. The callback is
// never called when inspection fails, and its error is propagated unchanged.
func Load(binary []byte, allowed []AllowedImport, instantiate InstantiateFunc) (*Capabilities, error) {
	caps, err := Inspect(binary, allowed)
	if err != nil {
		return nil, err
	}
	if instantiate == nil {
		return caps, errors.New("wasmcheck: instantiation callback is nil")
	}
	if err := instantiate(caps); err != nil {
		return caps, err
	}
	return caps, nil
}

func checkCustom(r *reader) error {
	name, err := r.name()
	if err != nil {
		return err
	}
	if name == "" {
		return errors.New("custom section has empty name")
	}
	// The remaining bytes are uninterpreted custom data; the bounded reader
	// already guarantees they stay inside the declared section length.
	return nil
}

func (s *state) capabilities() *Capabilities {
	caps := &Capabilities{
		types:        make([]FuncType, len(s.types)),
		imports:      append([]Import(nil), s.imports...),
		definedFuncs: append([]uint32(nil), s.definedFuncs...),
		tables:       append([]Table(nil), s.tables...),
		exports:      append([]Export(nil), s.exports...),
		elements:     make([]ElementSegment, len(s.elements)),
		importedFunc: s.importedFuncs,
		totalFunc:    s.importedFuncs + uint32(len(s.definedFuncs)),
	}
	for i, t := range s.types {
		caps.types[i] = FuncType{
			Params:  append([]byte(nil), t.Params...),
			Results: append([]byte(nil), t.Results...),
		}
	}
	for i, e := range s.elements {
		e.FuncIndices = append([]uint32(nil), e.FuncIndices...)
		caps.elements[i] = e
	}
	return caps
}
