package expropt

import (
	"fmt"
	"strings"
)

// Dump renders n as an indented tree, one node per line, each annotated
// with its source position as @offset.
func Dump(n Node) string {
	var sb strings.Builder
	dump(&sb, n, "")
	return sb.String()
}

func dump(sb *strings.Builder, n Node, indent string) {
	switch n := n.(type) {
	case *Const:
		fmt.Fprintf(sb, "%sConst(%d) @%d\n", indent, n.Val, n.At)
	case *Truthy:
		fmt.Fprintf(sb, "%sTruthy @%d\n", indent, n.At)
		dump(sb, n.X, indent+"  ")
	case *Binary:
		fmt.Fprintf(sb, "%s%s @%d\n", indent, n.Op, n.At)
		dump(sb, n.L, indent+"  ")
		dump(sb, n.R, indent+"  ")
	default:
		fmt.Fprintf(sb, "%s<unknown %T>\n", indent, n)
	}
}
