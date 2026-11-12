package dataeng

// refScalar is a decoded, nullable scalar value used by the row-by-row
// reference interpreter.
type refScalar struct {
	kind   ColumnType
	isNull bool
	intVal int64
	strVal string
}

// decodeBatch converts every dictionary-encoded column into per-row scalars.
// Duplicate dictionary entries naturally decode to equal values here.
func decodeBatch(schema Schema, batch *Batch) ([]map[string]refScalar, error) {
	if err := validateBatch(schema, batch); err != nil {
		return nil, err
	}
	rows := make([]map[string]refScalar, batch.RowCount)
	for row := range rows {
		rows[row] = map[string]refScalar{}
	}
	for name, kind := range schema.Columns {
		for row := 0; row < batch.RowCount; row++ {
			switch kind {
			case TypeInt64:
				col := batch.Columns[name].(*Int64Column)
				idx := col.Values[row]
				if idx < 0 {
					rows[row][name] = refScalar{kind: kind, isNull: true}
				} else {
					rows[row][name] = refScalar{kind: kind, intVal: col.Dict[idx]}
				}
			case TypeString:
				col := batch.Columns[name].(*StringColumn)
				idx := col.Values[row]
				if idx < 0 {
					rows[row][name] = refScalar{kind: kind, isNull: true}
				} else {
					rows[row][name] = refScalar{kind: kind, strVal: col.Dict[idx]}
				}
			}
		}
	}
	return rows, nil
}

// evalReference evaluates a parsed expression one row at a time using
// explicit three-valued logic. It intentionally shares no evaluation code
// with the production bitmap engine.
func evalReference(node Node, rows []map[string]refScalar) []tri {
	out := make([]tri, len(rows))
	for row, values := range rows {
		out[row] = evalRefBool(node, values)
	}
	return out
}

func evalRefBool(node Node, row map[string]refScalar) tri {
	expr := node.(*BoolExpr)
	switch expr.Op {
	case "and":
		return and3(evalRefBool(expr.Left, row), evalRefBool(expr.Right, row))
	case "or":
		return or3(evalRefBool(expr.Left, row), evalRefBool(expr.Right, row))
	case "not":
		return not3(evalRefBool(expr.Left, row))
	case "isnull":
		return boolTri(evalRefValue(expr.Left, row).isNull)
	case "cmp":
		left := evalRefValue(expr.Left, row)
		right := evalRefValue(expr.Right, row)
		if left.isNull || right.isNull {
			return triUnknown
		}
		cmp := compareScalars(
			scalar{kind: left.kind, intVal: left.intVal, strVal: left.strVal},
			scalar{kind: right.kind, intVal: right.intVal, strVal: right.strVal},
		)
		switch expr.Cmp {
		case CmpEq:
			return boolTri(cmp == 0)
		case CmpLt:
			return boolTri(cmp < 0)
		case CmpLe:
			return boolTri(cmp <= 0)
		}
	}
	return triUnknown
}

func evalRefValue(node Node, row map[string]refScalar) refScalar {
	value := node.(*ValueExpr)
	if value.IsColumn {
		return row[value.Column]
	}
	if value.IsNull {
		return refScalar{isNull: true}
	}
	return refScalar{kind: value.Type, intVal: value.IntVal, strVal: value.StrVal}
}
