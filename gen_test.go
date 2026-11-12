package dataeng

import "math/rand"

// genSchema builds a random schema whose columns are named c0, c1, ... with
// a random mix of nullable int64 and string types.
func genSchema(rng *rand.Rand) Schema {
	columnCount := 1 + rng.Intn(5)
	schema := Schema{Columns: make(map[string]ColumnType, columnCount)}
	for i := 0; i < columnCount; i++ {
		name := "c" + strconvItoa(i)
		if rng.Intn(2) == 0 {
			schema.Columns[name] = TypeInt64
		} else {
			schema.Columns[name] = TypeString
		}
	}
	return schema
}

func schemaNames(schema Schema) []string {
	names := make([]string, 0, len(schema.Columns))
	for name := range schema.Columns {
		names = append(names, name)
	}
	sortStrings(names)
	return names
}

func columnsOfType(schema Schema, kind ColumnType) []string {
	var out []string
	for _, name := range schemaNames(schema) {
		if schema.Columns[name] == kind {
			out = append(out, name)
		}
	}
	return out
}

// genValue produces a typed value expression: a column reference when a
// matching column exists, otherwise a literal, with a chance of NULL.
func genValue(rng *rand.Rand, schema Schema, kind ColumnType) *ValueExpr {
	switch rng.Intn(3) {
	case 0:
		if names := columnsOfType(schema, kind); len(names) > 0 {
			return &ValueExpr{IsColumn: true, Column: names[rng.Intn(len(names))]}
		}
	case 1:
		return &ValueExpr{IsNull: true}
	}
	return genLiteral(rng, kind)
}

func genLiteral(rng *rand.Rand, kind ColumnType) *ValueExpr {
	if kind == TypeInt64 {
		return &ValueExpr{Type: TypeInt64, IntVal: int64(rng.Intn(10))}
	}
	words := []string{"", "a", "b", "aa", "ab", "ba", "aaa", "z"}
	return &ValueExpr{Type: TypeString, StrVal: words[rng.Intn(len(words))]}
}

// genBool builds a randomly nested boolean expression bounded by depth.
func genBool(rng *rand.Rand, schema Schema, depth int) Node {
	if depth <= 0 || rng.Intn(3) == 0 {
		return genLeaf(rng, schema)
	}
	switch rng.Intn(4) {
	case 0:
		return &BoolExpr{Op: "and", Left: genBool(rng, schema, depth-1), Right: genBool(rng, schema, depth-1)}
	case 1:
		return &BoolExpr{Op: "or", Left: genBool(rng, schema, depth-1), Right: genBool(rng, schema, depth-1)}
	case 2:
		return &BoolExpr{Op: "not", Left: genBool(rng, schema, depth-1)}
	default:
		return genLeaf(rng, schema)
	}
}

func genLeaf(rng *rand.Rand, schema Schema) Node {
	names := schemaNames(schema)
	kind := schema.Columns[names[rng.Intn(len(names))]]
	if rng.Intn(2) == 0 {
		return &BoolExpr{
			Op:   "isnull",
			Left: genValue(rng, schema, kind),
		}
	}
	ops := []CmpOp{CmpEq, CmpLt, CmpLe}
	return &BoolExpr{
		Op:    "cmp",
		Cmp:   ops[rng.Intn(len(ops))],
		Left:  genValue(rng, schema, kind),
		Right: genValue(rng, schema, kind),
	}
}

// genBatch builds a dictionary-encoded batch. Options force scenarios that
// are easy to miss at random: fully null columns and repeated dictionary
// values.
type batchOptions struct {
	allNull       bool
	dupDictionary bool
}

func genBatch(rng *rand.Rand, schema Schema, rowCount int, opts batchOptions) *Batch {
	batch := &Batch{RowCount: rowCount, Columns: map[string]any{}}
	for name, kind := range schema.Columns {
		switch kind {
		case TypeInt64:
			dict := []int64{int64(rng.Intn(7)) - 3, int64(rng.Intn(7)) - 3, int64(rng.Intn(7)) - 3}
			if opts.dupDictionary {
				dict[2] = dict[0]
			}
			values := make([]int32, rowCount)
			for row := range values {
				switch {
				case opts.allNull:
					values[row] = -1
				case rng.Intn(3) == 0:
					values[row] = -1
				default:
					values[row] = int32(rng.Intn(len(dict)))
				}
			}
			batch.Columns[name] = &Int64Column{Dict: dict, Values: values}
		case TypeString:
			dict := []string{"a", "b", "a"}
			if !opts.dupDictionary {
				dict[2] = "c"
			}
			values := make([]int32, rowCount)
			for row := range values {
				switch {
				case opts.allNull:
					values[row] = -1
				case rng.Intn(3) == 0:
					values[row] = -1
				default:
					values[row] = int32(rng.Intn(len(dict)))
				}
			}
			batch.Columns[name] = &StringColumn{Dict: dict, Values: values}
		}
	}
	return batch
}

func strconvItoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

func sortStrings(items []string) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j-1] > items[j]; j-- {
			items[j-1], items[j] = items[j], items[j-1]
		}
	}
}
