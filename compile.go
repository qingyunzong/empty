package dataeng

import (
	"fmt"
	"math"
)

// Layout is an immutable, compiled record layout. It is safe to share between
// goroutines; Decode keeps all mutable state local to the call.
type Layout struct {
	ast      *AST
	root     *layoutNode
	overlays map[string]*layoutOverlay
	minSize  int64
	maxSize  int64
}

type layoutNode struct {
	ast       *Node
	parent    *layoutNode
	children  []*layoutNode
	depth     int
	rootIndex int
	occurs    *layoutOccurs
}

type layoutOccurs struct {
	max      int
	variable bool
	control  *layoutNode
}

type layoutOverlay struct {
	name        string
	control     *layoutNode
	branches    []*layoutNode
	branchByKey map[string]*layoutNode
	values      map[uint64]string
	span        int64
}

// Compile validates an AST and computes its physical extent. It does not
// interpret any COBOL text.
func Compile(ast *AST) (*Layout, error) {
	if ast == nil || ast.Root == nil {
		return nil, &CompileError{Reason: "AST and root node are required"}
	}
	ast = cloneAST(ast)
	if ast.Root.Kind != Group {
		return nil, &CompileError{Path: ast.Root.Path, Reason: "root node must be a group"}
	}
	if ast.Root.Occurs != nil {
		return nil, &CompileError{Path: ast.Root.Path, Reason: "root node cannot have OCCURS"}
	}
	if ast.Root.Overlay != "" {
		return nil, &CompileError{Path: ast.Root.Path, Reason: "root node cannot be an overlay branch"}
	}

	l := &Layout{ast: ast, overlays: map[string]*layoutOverlay{}}
	pathSet := map[string]bool{}
	pathMap := map[string]*layoutNode{}
	root, err := buildNode(ast.Root, nil, 0, -1, pathSet, pathMap)
	if err != nil {
		return nil, err
	}
	l.root = root

	if err := l.compileOccurs(pathMap); err != nil {
		return nil, err
	}
	if err := l.compileOverlays(pathMap); err != nil {
		return nil, err
	}

	minSize, maxSize, err := l.calcNode(root)
	if err != nil {
		return nil, err
	}
	l.minSize = minSize
	l.maxSize = maxSize
	return l, nil
}

func cloneAST(ast *AST) *AST {
	out := &AST{Root: cloneNode(ast.Root)}
	out.Overlays = make([]Overlay, len(ast.Overlays))
	for i, spec := range ast.Overlays {
		out.Overlays[i] = Overlay{Name: spec.Name, Control: spec.Control}
		if spec.Branches != nil {
			out.Overlays[i].Branches = make(map[uint64]string, len(spec.Branches))
			for value, path := range spec.Branches {
				out.Overlays[i].Branches[value] = path
			}
		}
	}
	return out
}

func cloneNode(n *Node) *Node {
	if n == nil {
		return nil
	}
	out := *n
	if n.Occurs != nil {
		occ := *n.Occurs
		out.Occurs = &occ
	}
	if n.Children != nil {
		out.Children = make([]*Node, len(n.Children))
		for i, child := range n.Children {
			out.Children[i] = cloneNode(child)
		}
	}
	return &out
}

func buildNode(n *Node, parent *layoutNode, depth, rootIndex int, pathSet map[string]bool, pathMap map[string]*layoutNode) (*layoutNode, error) {
	if n == nil {
		return nil, &CompileError{Reason: "nil AST node"}
	}
	if n.Path == "" && depth > 0 {
		return nil, &CompileError{Reason: "non-root node has an empty path"}
	}
	if pathSet[n.Path] {
		return nil, &CompileError{Path: n.Path, Reason: "duplicate field path"}
	}
	pathSet[n.Path] = true

	if err := validateShape(n); err != nil {
		return nil, err
	}
	if n.Overlay != "" && depth != 1 {
		return nil, &CompileError{Path: n.Path, Reason: "REDEFINES group is only valid at the root level"}
	}

	ln := &layoutNode{ast: n, parent: parent, depth: depth, rootIndex: rootIndex}
	pathMap[n.Path] = ln

	if n.Occurs != nil {
		if n.Occurs.Max < 0 {
			return nil, &CompileError{Path: n.Path, Reason: "OCCURS maximum cannot be negative"}
		}
		if n.Occurs.DependingOn == "" && n.Occurs.Max <= 0 {
			return nil, &CompileError{Path: n.Path, Reason: "fixed OCCURS count must be positive"}
		}
	}

	if n.Kind == Group {
		for i, child := range n.Children {
			childRootIndex := rootIndex
			if depth == 0 {
				childRootIndex = i
			}
			cn, err := buildNode(child, ln, depth+1, childRootIndex, pathSet, pathMap)
			if err != nil {
				return nil, err
			}
			ln.children = append(ln.children, cn)
		}
	}
	return ln, nil
}

func validateShape(n *Node) error {
	switch n.Kind {
	case Group:
		if n.Digits != 0 || n.Scale != 0 || n.Bytes != 0 {
			return &CompileError{Path: n.Path, Reason: "group cannot have digit, scale, or byte-length attributes"}
		}
	case UnsignedDisplay:
		if len(n.Children) != 0 {
			return &CompileError{Path: n.Path, Reason: "display decimal cannot have children"}
		}
		if n.Digits <= 0 {
			return &CompileError{Path: n.Path, Reason: "display decimal digit count must be positive"}
		}
		if n.Bytes != 0 {
			return &CompileError{Path: n.Path, Reason: "display decimal cannot specify a raw byte length"}
		}
		if n.Scale != 0 {
			return &CompileError{Path: n.Path, Reason: "display decimal cannot specify a scale"}
		}
	case SignedPacked:
		if len(n.Children) != 0 {
			return &CompileError{Path: n.Path, Reason: "packed decimal cannot have children"}
		}
		if n.Digits <= 0 {
			return &CompileError{Path: n.Path, Reason: "packed decimal digit count must be positive"}
		}
		if n.Scale < 0 || n.Scale > n.Digits {
			return &CompileError{Path: n.Path, Reason: "packed decimal scale must be between zero and the digit count"}
		}
		if n.Bytes != 0 {
			return &CompileError{Path: n.Path, Reason: "packed decimal cannot specify a raw byte length"}
		}
	case RawBytes:
		if len(n.Children) != 0 {
			return &CompileError{Path: n.Path, Reason: "raw bytes field cannot have children"}
		}
		if n.Bytes < 0 {
			return &CompileError{Path: n.Path, Reason: "raw byte length cannot be negative"}
		}
		if n.Digits != 0 || n.Scale != 0 {
			return &CompileError{Path: n.Path, Reason: "raw bytes field cannot have digit or scale attributes"}
		}
	default:
		return &CompileError{Path: n.Path, Reason: fmt.Sprintf("unknown node kind %q", n.Kind)}
	}
	return nil
}

func (l *Layout) compileOccurs(pathMap map[string]*layoutNode) error {
	var walk func(n *layoutNode) error
	walk = func(n *layoutNode) error {
		if n.ast.Occurs != nil {
			occ := n.ast.Occurs
			n.occurs = &layoutOccurs{max: occ.Max, variable: occ.DependingOn != ""}
			if occ.DependingOn != "" {
				control := pathMap[occ.DependingOn]
				if control == nil {
					return &CompileError{Path: n.ast.Path, Reason: fmt.Sprintf("DEPENDING ON references unknown field %q", occ.DependingOn)}
				}
				if control.depth != 1 {
					return &CompileError{Path: n.ast.Path, Reason: fmt.Sprintf("DEPENDING ON field %q is not at the root level", occ.DependingOn)}
				}
				if control.ast.Kind != UnsignedDisplay {
					return &CompileError{Path: n.ast.Path, Reason: fmt.Sprintf("DEPENDING ON field %q is not an unsigned display scalar", occ.DependingOn)}
				}
				if control.ast.Occurs != nil {
					return &CompileError{Path: n.ast.Path, Reason: fmt.Sprintf("DEPENDING ON field %q repeats", occ.DependingOn)}
				}
				if control.ast.Overlay != "" {
					return &CompileError{Path: n.ast.Path, Reason: fmt.Sprintf("DEPENDING ON field %q is inside an overlay branch", occ.DependingOn)}
				}
				if control.rootIndex >= n.rootIndex {
					return &CompileError{Path: n.ast.Path, Reason: fmt.Sprintf("DEPENDING ON field %q is not decoded before this node", occ.DependingOn)}
				}
				n.occurs.control = control
			}
		}
		for _, child := range n.children {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(l.root)
}

func (l *Layout) compileOverlays(pathMap map[string]*layoutNode) error {
	rootNodes := l.root.children
	runs := map[string][]*layoutNode{}
	seen := map[string]bool{}
	for i := 0; i < len(rootNodes); {
		name := rootNodes[i].ast.Overlay
		if name == "" {
			i++
			continue
		}
		j := i + 1
		for j < len(rootNodes) && rootNodes[j].ast.Overlay == name {
			j++
		}
		run := rootNodes[i:j]
		if seen[name] {
			return &CompileError{Path: run[0].ast.Path, Reason: fmt.Sprintf("overlay %q branches are not adjacent", name)}
		}
		seen[name] = true
		runs[name] = run
		if len(run) < 2 {
			return &CompileError{Path: run[0].ast.Path, Reason: fmt.Sprintf("overlay %q needs at least two branches", name)}
		}
		i = j
	}

	specs := map[string]Overlay{}
	for _, spec := range l.ast.Overlays {
		if spec.Name == "" {
			return &CompileError{Reason: "overlay name cannot be empty"}
		}
		if _, ok := specs[spec.Name]; ok {
			return &CompileError{Path: spec.Control, Reason: fmt.Sprintf("duplicate overlay definition %q", spec.Name)}
		}
		specs[spec.Name] = spec
	}

	for name, run := range runs {
		spec, ok := specs[name]
		if !ok {
			return &CompileError{Path: run[0].ast.Path, Reason: fmt.Sprintf("overlay %q has no branch table", name)}
		}
		control := pathMap[spec.Control]
		if control == nil {
			return &CompileError{Path: run[0].ast.Path, Reason: fmt.Sprintf("overlay %q references unknown control field %q", name, spec.Control)}
		}
		if control.depth != 1 || control.ast.Kind != UnsignedDisplay || control.ast.Occurs != nil || control.ast.Overlay != "" {
			return &CompileError{Path: control.ast.Path, Reason: fmt.Sprintf("overlay %q control must be a preceding root-level, non-repeating unsigned display scalar", name)}
		}
		if control.rootIndex >= run[0].rootIndex {
			return &CompileError{Path: control.ast.Path, Reason: fmt.Sprintf("overlay %q control is not decoded before the branches", name)}
		}

		ov := &layoutOverlay{
			name:        name,
			control:     control,
			branches:    run,
			branchByKey: map[string]*layoutNode{},
			values:      map[uint64]string{},
		}
		for _, branch := range run {
			if err := rejectVariableOccurs(branch, name); err != nil {
				return err
			}
			ov.branchByKey[branch.ast.Path] = branch
		}
		if len(spec.Branches) == 0 {
			return &CompileError{Path: control.ast.Path, Reason: fmt.Sprintf("overlay %q has an empty branch table", name)}
		}
		for value, path := range spec.Branches {
			branch := pathMap[path]
			if branch == nil {
				return &CompileError{Path: path, Reason: fmt.Sprintf("overlay %q branch path does not exist", name)}
			}
			if branch.ast.Overlay != name {
				return &CompileError{Path: path, Reason: fmt.Sprintf("overlay %q branch path does not belong to this overlay", name)}
			}
			if _, ok := ov.branchByKey[path]; !ok {
				return &CompileError{Path: path, Reason: fmt.Sprintf("overlay %q branch path is not adjacent", name)}
			}
			ov.values[value] = path
		}
		l.overlays[name] = ov
	}

	for name := range specs {
		if !seen[name] {
			return &CompileError{Reason: fmt.Sprintf("overlay %q is defined but has no branch roots", name)}
		}
	}
	return nil
}

func rejectVariableOccurs(n *layoutNode, overlay string) error {
	if n.ast.Occurs != nil && n.ast.Occurs.DependingOn != "" {
		return &CompileError{Path: n.ast.Path, Reason: fmt.Sprintf("variable OCCURS is not allowed inside overlay %q", overlay)}
	}
	for _, child := range n.children {
		if err := rejectVariableOccurs(child, overlay); err != nil {
			return err
		}
	}
	return nil
}

func (l *Layout) calcNode(n *layoutNode) (int64, int64, error) {
	var contentMin, contentMax int64
	switch n.ast.Kind {
	case UnsignedDisplay:
		contentMin = int64(n.ast.Digits)
		contentMax = contentMin
	case SignedPacked:
		contentMin = int64(n.ast.Digits/2 + 1)
		contentMax = contentMin
	case RawBytes:
		contentMin = int64(n.ast.Bytes)
		contentMax = contentMin
	case Group:
		if n != l.root {
			for _, child := range n.children {
				cmin, cmax, err := l.calcNode(child)
				if err != nil {
					return 0, 0, err
				}
				contentMin, err = addSize(contentMin, cmin, child)
				if err != nil {
					return 0, 0, err
				}
				contentMax, err = addSize(contentMax, cmax, child)
				if err != nil {
					return 0, 0, err
				}
			}
			break
		}
		nodes := n.children
		for i := 0; i < len(nodes); {
			if name := nodes[i].ast.Overlay; name != "" {
				j := i + 1
				for j < len(nodes) && nodes[j].ast.Overlay == name {
					j++
				}
				ov := l.overlays[name]
				span, err := l.calcOverlaySpan(ov)
				if err != nil {
					return 0, 0, err
				}
				contentMin, err = addSize(contentMin, span, nodes[i])
				if err != nil {
					return 0, 0, err
				}
				contentMax, err = addSize(contentMax, span, nodes[i])
				if err != nil {
					return 0, 0, err
				}
				i = j
				continue
			}
			cmin, cmax, err := l.calcNode(nodes[i])
			if err != nil {
				return 0, 0, err
			}
			contentMin, err = addSize(contentMin, cmin, nodes[i])
			if err != nil {
				return 0, 0, err
			}
			contentMax, err = addSize(contentMax, cmax, nodes[i])
			if err != nil {
				return 0, 0, err
			}
			i++
		}
	}
	return applyOccurs(n, contentMin, contentMax)
}

func (l *Layout) calcOverlaySpan(ov *layoutOverlay) (int64, error) {
	var span int64
	for _, branch := range ov.branches {
		bmin, bmax, err := l.calcNode(branch)
		if err != nil {
			return 0, err
		}
		if bmin != bmax {
			return 0, &CompileError{Path: branch.ast.Path, Reason: fmt.Sprintf("overlay %q branch is not fixed length", ov.name)}
		}
		if bmax > span {
			span = bmax
		}
	}
	ov.span = span
	return span, nil
}

func applyOccurs(n *layoutNode, contentMin, contentMax int64) (int64, int64, error) {
	if n.occurs == nil {
		return contentMin, contentMax, nil
	}
	count := int64(n.occurs.max)
	var minSize int64
	if !n.occurs.variable {
		var err error
		minSize, err = multiplySize(contentMin, count, n)
		if err != nil {
			return 0, 0, err
		}
	}
	maxSize, err := multiplySize(contentMax, count, n)
	if err != nil {
		return 0, 0, err
	}
	return minSize, maxSize, nil
}

func addSize(a, b int64, n *layoutNode) (int64, error) {
	if b > math.MaxInt64-a {
		return 0, &CompileError{Path: n.ast.Path, Reason: "layout size overflows int64"}
	}
	return a + b, nil
}

func multiplySize(a, b int64, n *layoutNode) (int64, error) {
	if a < 0 || b < 0 {
		return 0, &CompileError{Path: n.ast.Path, Reason: "negative layout size"}
	}
	if a != 0 && b > math.MaxInt64/a {
		return 0, &CompileError{Path: n.ast.Path, Reason: "OCCURS count multiplication overflows int64"}
	}
	return a * b, nil
}

// MinSize returns the smallest possible record size in bytes.
func (l *Layout) MinSize() int64 {
	return l.minSize
}

// MaxSize returns the largest possible record size in bytes. For layouts with
// only fixed fields this equals MinSize.
func (l *Layout) MaxSize() int64 {
	return l.maxSize
}
