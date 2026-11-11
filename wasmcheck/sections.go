package wasmcheck

import "fmt"

func isValidValueType(v byte) bool {
	switch v {
	case valTypeI32, valTypeI64, valTypeF32, valTypeF64:
		return true
	default:
		return false
	}
}

func typesEqual(a, b FuncType) bool {
	return bytesEqual(a.Params, b.Params) && bytesEqual(a.Results, b.Results)
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func readFuncType(r *reader) (FuncType, error) {
	marker, err := r.readByte()
	if err != nil {
		return FuncType{}, err
	}
	if marker != funcTypeMarker {
		return FuncType{}, fmt.Errorf("expected function type marker 0x60, got 0x%02x", marker)
	}
	paramCount, err := r.count()
	if err != nil {
		return FuncType{}, err
	}
	params := make([]byte, paramCount)
	for i := range params {
		params[i], err = r.readByte()
		if err != nil {
			return FuncType{}, err
		}
		if !isValidValueType(params[i]) {
			return FuncType{}, fmt.Errorf("invalid parameter value type 0x%02x", params[i])
		}
	}
	resultCount, err := r.count()
	if err != nil {
		return FuncType{}, err
	}
	results := make([]byte, resultCount)
	for i := range results {
		results[i], err = r.readByte()
		if err != nil {
			return FuncType{}, err
		}
		if !isValidValueType(results[i]) {
			return FuncType{}, fmt.Errorf("invalid result value type 0x%02x", results[i])
		}
	}
	return FuncType{Params: params, Results: results}, nil
}

func (s *state) parseTypes(r *reader) error {
	n, err := r.count()
	if err != nil {
		return err
	}
	s.types = make([]FuncType, n)
	for i := 0; i < n; i++ {
		s.types[i], err = readFuncType(r)
		if err != nil {
			return fmt.Errorf("type %d: %w", i, err)
		}
	}
	return nil
}

func (s *state) parseImports(r *reader, allow map[importKey]FuncType) error {
	n, err := r.count()
	if err != nil {
		return err
	}
	seen := make(map[importKey]bool, n)
	for i := 0; i < n; i++ {
		module, err := r.name()
		if err != nil {
			return err
		}
		field, err := r.name()
		if err != nil {
			return err
		}
		if module == "" || field == "" {
			return fmt.Errorf("import %d has empty module or field name", i)
		}
		kind, err := r.readByte()
		if err != nil {
			return err
		}
		if kind != kindFunction {
			return fmt.Errorf("import %s.%s: only function imports are allowed, got kind 0x%02x", module, field, kind)
		}
		typeIndex, err := r.u32()
		if err != nil {
			return err
		}
		if int(typeIndex) >= len(s.types) {
			return fmt.Errorf("import %s.%s type index %d out of range (%d types)", module, field, typeIndex, len(s.types))
		}
		key := importKey{module: module, field: field}
		want, ok := allow[key]
		if !ok {
			return fmt.Errorf("import %s.%s is not in the host allowlist", module, field)
		}
		if !typesEqual(want, s.types[typeIndex]) {
			return fmt.Errorf("import %s.%s signature does not match the allowed function type", module, field)
		}
		if seen[key] {
			return fmt.Errorf("duplicate import %s.%s", module, field)
		}
		seen[key] = true
		s.imports = append(s.imports, Import{
			Module:    module,
			Field:     field,
			FuncIndex: s.importedFuncs,
			TypeIndex: typeIndex,
		})
		s.importedFuncs++
	}
	return nil
}

func (s *state) parseFunctions(r *reader) error {
	n, err := r.count()
	if err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		typeIndex, err := r.u32()
		if err != nil {
			return err
		}
		if int(typeIndex) >= len(s.types) {
			return fmt.Errorf("function %d type index %d out of range (%d types)", i, typeIndex, len(s.types))
		}
		s.definedFuncs = append(s.definedFuncs, typeIndex)
	}
	return nil
}

func (s *state) parseTables(r *reader) error {
	n, err := r.count()
	if err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		elemType, err := r.readByte()
		if err != nil {
			return err
		}
		if elemType != funcrefType {
			return fmt.Errorf("table %d: only funcref (0x70) tables are allowed, got 0x%02x", i, elemType)
		}
		flags, err := r.readByte()
		if err != nil {
			return err
		}
		table := Table{}
		switch flags {
		case 0x00:
			table.HasMax = false
		case 0x01:
			table.HasMax = true
		default:
			return fmt.Errorf("table %d: unsupported limits flag 0x%02x", i, flags)
		}
		table.Min, err = r.u32()
		if err != nil {
			return err
		}
		if table.HasMax {
			table.Max, err = r.u32()
			if err != nil {
				return err
			}
			if table.Max < table.Min {
				return fmt.Errorf("table %d: max %d is smaller than min %d", i, table.Max, table.Min)
			}
		}
		s.tables = append(s.tables, table)
	}
	return nil
}

func (s *state) parseExports(r *reader) error {
	n, err := r.count()
	if err != nil {
		return err
	}
	seenNames := make(map[string]bool, n)
	for i := 0; i < n; i++ {
		name, err := r.name()
		if err != nil {
			return err
		}
		if name == "" {
			return fmt.Errorf("export %d has empty name", i)
		}
		if seenNames[name] {
			return fmt.Errorf("duplicate export name %q", name)
		}
		kind, err := r.readByte()
		if err != nil {
			return err
		}
		index, err := r.u32()
		if err != nil {
			return err
		}
		switch kind {
		case kindFunction:
			// Defined function indices must skip past the imported functions.
			if index < s.importedFuncs {
				return fmt.Errorf("export %q refers to imported function index %d", name, index)
			}
			if index >= s.importedFuncs+uint32(len(s.definedFuncs)) {
				return fmt.Errorf("export %q function index %d out of range", name, index)
			}
		case kindTable:
			if int(index) >= len(s.tables) {
				return fmt.Errorf("export %q table index %d out of range", name, index)
			}
		default:
			return fmt.Errorf("export %q: only function and table exports are allowed, got kind 0x%02x", name, kind)
		}
		seenNames[name] = true
		s.exports = append(s.exports, Export{Name: name, Kind: kind, Index: index})
	}
	return nil
}

// readConstOffset parses the MVP constant expression "i32.const <s32>; end"
// used as an active element segment offset. Any other instruction is rejected.
func readConstOffset(r *reader) (int32, error) {
	op, err := r.readByte()
	if err != nil {
		return 0, err
	}
	if op != valTypeI32 {
		return 0, fmt.Errorf("element offset must start with i32.const (0x7f), got 0x%02x", op)
	}
	offset, err := r.s32()
	if err != nil {
		return 0, err
	}
	end, err := r.readByte()
	if err != nil {
		return 0, err
	}
	if end != 0x0b {
		return 0, fmt.Errorf("element offset expression must end with 0x0b, got 0x%02x", end)
	}
	return offset, nil
}

func (s *state) parseElements(r *reader) error {
	n, err := r.count()
	if err != nil {
		return err
	}
	totalFuncs := s.importedFuncs + uint32(len(s.definedFuncs))
	for i := 0; i < n; i++ {
		flags, err := r.readByte()
		if err != nil {
			return err
		}
		// Only the two MVP active forms are accepted:
		//   0: table 0, funcref, plain function indices
		//   2: explicit table index, funcref, plain function indices
		// Passive/declarative forms, expression-initialized segments and
		// reference-type variants are all rejected.
		var tableIndex uint32
		switch flags {
		case 0x00:
			tableIndex = 0
			if len(s.tables) == 0 {
				return fmt.Errorf("element segment %d targets implicit table 0 but no table is defined", i)
			}
		case 0x02:
			tableIndex, err = r.u32()
			if err != nil {
				return err
			}
			if int(tableIndex) >= len(s.tables) {
				return fmt.Errorf("element segment %d table index %d out of range", i, tableIndex)
			}
		default:
			return fmt.Errorf("element segment %d: only active funcref segments (flags 0 or 2) are allowed, got %d", i, flags)
		}

		offset, err := readConstOffset(r)
		if err != nil {
			return fmt.Errorf("element segment %d offset: %w", i, err)
		}

		refCount, err := r.count()
		if err != nil {
			return err
		}
		refs := make([]uint32, refCount)
		for j := 0; j < refCount; j++ {
			refs[j], err = r.u32()
			if err != nil {
				return err
			}
			if refs[j] >= totalFuncs {
				return fmt.Errorf("element segment %d reference %d: function index %d is not reachable", i, j, refs[j])
			}
		}

		// Every declared table is a funcref table, so all reachable function
		// references conform to the target table element type.
		s.elements = append(s.elements, ElementSegment{
			TableIndex:  tableIndex,
			Offset:      offset,
			FuncIndices: refs,
		})
	}
	return nil
}
