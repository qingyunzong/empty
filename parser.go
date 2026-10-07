package effectcheck

import (
	"fmt"
	"regexp"
	"strings"
)

// ParseError is a syntax error with a source location.
type ParseError struct {
	P   Pos
	Msg string
}

func (e *ParseError) Error() string { return e.P.String() + ": " + e.Msg }

var (
	reIdent  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.]*$`)
	reFn     = regexp.MustCompile(`^fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:$`)
	reRegion = regexp.MustCompile(`^region\s+([A-Za-z_][A-Za-z0-9_.]*)$`)
	reRead   = regexp.MustCompile(`^read\s+([A-Za-z_][A-Za-z0-9_.]*)$`)
	reWrite  = regexp.MustCompile(`^write\s+([A-Za-z_][A-Za-z0-9_.]*)$`)
	reThrow  = regexp.MustCompile(`^throw\s+([A-Za-z_][A-Za-z0-9_.]*)$`)
	reReturn = regexp.MustCompile(`^return\s+([A-Za-z_][A-Za-z0-9_.]*)$`)
	reCall   = regexp.MustCompile(`^call\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)$`)
)

// Parse parses a source file into a Program. The file name is recorded in
// every position so diagnostics carry their source path.
func Parse(file, src string) (*Program, error) {
	prog := &Program{}
	seenGlobals := map[string]bool{}
	var cur *Func
	for i, raw := range lines(src) {
		pos := Pos{File: file, Line: i + 1}
		if idx := strings.Index(raw, "//"); idx >= 0 {
			raw = raw[:idx]
		}
		raw = strings.TrimRight(raw, " \t\r")
		trimmed := strings.TrimLeft(raw, " \t")
		if trimmed == "" {
			continue
		}
		pos.Col = len(raw) - len(trimmed) + 1
		switch {
		case trimmed == "fn" || strings.HasPrefix(trimmed, "fn "):
			m := reFn.FindStringSubmatch(trimmed)
			if m == nil {
				return nil, &ParseError{pos, "malformed fn header, want: fn name(p1, p2):"}
			}
			f := &Func{Name: m[1], P: pos}
			if strings.TrimSpace(m[2]) != "" {
				for _, p := range strings.Split(m[2], ",") {
					p = strings.TrimSpace(p)
					if !reIdent.MatchString(p) {
						return nil, &ParseError{pos, fmt.Sprintf("invalid parameter %q", p)}
					}
					f.Params = append(f.Params, p)
				}
			}
			if prog.Func(f.Name) != nil {
				return nil, &ParseError{pos, fmt.Sprintf("duplicate function %q", f.Name)}
			}
			prog.Funcs = append(prog.Funcs, f)
			cur = f
		case trimmed == "global" || strings.HasPrefix(trimmed, "global "):
			rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "global"))
			for _, g := range strings.Split(rest, ",") {
				g = strings.TrimSpace(g)
				if !reIdent.MatchString(g) {
					return nil, &ParseError{pos, fmt.Sprintf("invalid global region %q", g)}
				}
				if seenGlobals[g] {
					return nil, &ParseError{pos, fmt.Sprintf("duplicate global region %q", g)}
				}
				seenGlobals[g] = true
				prog.Globals = append(prog.Globals, g)
			}
		default:
			if cur == nil {
				return nil, &ParseError{pos, "statement outside of any function"}
			}
			stmt, err := parseStmt(trimmed, pos)
			if err != nil {
				return nil, err
			}
			cur.Body = append(cur.Body, stmt)
		}
	}
	return prog, nil
}

func lines(src string) []string { return strings.Split(src, "\n") }

func parseStmt(text string, pos Pos) (Stmt, error) {
	if m := reRegion.FindStringSubmatch(text); m != nil {
		return &RegionDecl{Name: m[1], P: pos}, nil
	}
	if m := reRead.FindStringSubmatch(text); m != nil {
		return &ReadStmt{Region: m[1], P: pos}, nil
	}
	if m := reWrite.FindStringSubmatch(text); m != nil {
		return &WriteStmt{Region: m[1], P: pos}, nil
	}
	if m := reThrow.FindStringSubmatch(text); m != nil {
		return &ThrowStmt{Exn: m[1], P: pos}, nil
	}
	if m := reReturn.FindStringSubmatch(text); m != nil {
		return &ReturnStmt{Region: m[1], P: pos}, nil
	}
	if m := reCall.FindStringSubmatch(text); m != nil {
		call := &CallStmt{Callee: m[1], P: pos}
		if strings.TrimSpace(m[2]) != "" {
			for _, a := range strings.Split(m[2], ",") {
				a = strings.TrimSpace(a)
				if !reIdent.MatchString(a) {
					return nil, &ParseError{pos, fmt.Sprintf("invalid call argument %q", a)}
				}
				call.Args = append(call.Args, a)
			}
		}
		return call, nil
	}
	return nil, &ParseError{pos, fmt.Sprintf("unknown statement %q", text)}
}
