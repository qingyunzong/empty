package dataeng

import "strconv"

// formatNode renders a parsed expression back into canonical predicate
// source. The random generator feeds the same source to Compile and the
// reference interpreter, so this also serves as a parser round-trip check.
func formatNode(node Node) string {
	switch n := node.(type) {
	case *ValueExpr:
		return formatValue(n)
	case *BoolExpr:
		switch n.Op {
		case "and":
			return "(" + formatNode(n.Left) + " AND " + formatNode(n.Right) + ")"
		case "or":
			return "(" + formatNode(n.Left) + " OR " + formatNode(n.Right) + ")"
		case "not":
			return "NOT " + formatNode(n.Left)
		case "isnull":
			return formatNode(n.Left) + " IS NULL"
		case "cmp":
			return formatNode(n.Left) + " " + n.Cmp.String() + " " + formatNode(n.Right)
		}
	}
	return ""
}

func formatValue(v *ValueExpr) string {
	if v.IsColumn {
		return v.Column
	}
	if v.IsNull {
		return "NULL"
	}
	switch v.Type {
	case TypeInt64:
		return strconv.FormatInt(v.IntVal, 10)
	case TypeString:
		return "'" + v.StrVal + "'"
	}
	return ""
}
