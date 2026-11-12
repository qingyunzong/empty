package dataeng

import (
	"math"
	"strings"
	"testing"
)

func TestCompileRejectsInvalidLayouts(t *testing.T) {
	maxInt := int(math.MaxInt64)
	tests := []struct {
		name string
		ast  func() *AST
		want string
	}{
		{
			name: "duplicate path",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "A", Kind: UnsignedDisplay, Digits: 1},
					{Path: "A", Kind: UnsignedDisplay, Digits: 1},
				}}}
			},
			want: "duplicate field path",
		},
		{
			name: "duplicate nested path",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "G", Kind: Group, Children: []*Node{{Path: "A", Kind: RawBytes, Bytes: 1}}},
					{Path: "A", Kind: RawBytes, Bytes: 1},
				}}}
			},
			want: "duplicate field path",
		},
		{
			name: "forward control reference",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "ARR", Kind: Group, Occurs: UpTo(2, "CNT"), Children: []*Node{
						{Path: "X", Kind: RawBytes, Bytes: 1},
					}},
					{Path: "CNT", Kind: UnsignedDisplay, Digits: 1},
				}}}
			},
			want: "not decoded before",
		},
		{
			name: "control in overlay branch",
			ast: func() *AST {
				return &AST{
					Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
						{Path: "KIND", Kind: UnsignedDisplay, Digits: 1},
						{Path: "A", Kind: UnsignedDisplay, Digits: 1, Overlay: "O"},
						{Path: "B", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
						{Path: "ARR", Kind: RawBytes, Bytes: 1, Occurs: UpTo(2, "A")},
					}},
					Overlays: []Overlay{{Name: "O", Control: "KIND", Branches: map[uint64]string{1: "A", 2: "B"}}},
				}
			},
			want: "inside an overlay branch",
		},
		{
			name: "control repeats",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "CNT", Kind: UnsignedDisplay, Digits: 1, Occurs: Fixed(1)},
					{Path: "ARR", Kind: RawBytes, Bytes: 1, Occurs: UpTo(2, "CNT")},
				}}}
			},
			want: "repeats",
		},
		{
			name: "control is not unsigned",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "CNT", Kind: SignedPacked, Digits: 2},
					{Path: "ARR", Kind: RawBytes, Bytes: 1, Occurs: UpTo(2, "CNT")},
				}}}
			},
			want: "not an unsigned display scalar",
		},
		{
			name: "count product overflows",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "B", Kind: RawBytes, Bytes: maxInt, Occurs: Fixed(2)},
				}}}
			},
			want: "overflows int64",
		},
		{
			name: "display with raw length",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "A", Kind: UnsignedDisplay, Digits: 2, Bytes: 2},
				}}}
			},
			want: "raw byte length",
		},
		{
			name: "packed scale too large",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "P", Kind: SignedPacked, Digits: 2, Scale: 3},
				}}}
			},
			want: "scale",
		},
		{
			name: "group with leaf attribute",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "G", Kind: Group, Digits: 2},
				}}}
			},
			want: "group cannot have",
		},
		{
			name: "negative raw length",
			ast: func() *AST {
				return &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
					{Path: "B", Kind: RawBytes, Bytes: -1},
				}}}
			},
			want: "cannot be negative",
		},
		{
			name: "variable occurs inside overlay",
			ast: func() *AST {
				return &AST{
					Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
						{Path: "KIND", Kind: UnsignedDisplay, Digits: 1},
						{Path: "A", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
						{Path: "B", Kind: Group, Overlay: "O", Children: []*Node{
							{Path: "ARR", Kind: RawBytes, Bytes: 1, Occurs: UpTo(2, "KIND")},
						}},
					}},
					Overlays: []Overlay{{Name: "O", Control: "KIND", Branches: map[uint64]string{1: "A", 2: "B"}}},
				}
			},
			want: "variable OCCURS",
		},
		{
			name: "overlay control is itself a branch",
			ast: func() *AST {
				return &AST{
					Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
						{Path: "A", Kind: UnsignedDisplay, Digits: 1, Overlay: "O"},
						{Path: "B", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
					}},
					Overlays: []Overlay{{Name: "O", Control: "A", Branches: map[uint64]string{1: "A", 2: "B"}}},
				}
			},
			want: "control must be a preceding root-level",
		},
		{
			name: "overlay branches not adjacent",
			ast: func() *AST {
				return &AST{
					Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
						{Path: "KIND", Kind: UnsignedDisplay, Digits: 1},
						{Path: "A", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
						{Path: "A2", Kind: UnsignedDisplay, Digits: 3, Overlay: "O"},
						{Path: "M", Kind: RawBytes, Bytes: 1},
						{Path: "A3", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
					}},
					Overlays: []Overlay{{Name: "O", Control: "KIND", Branches: map[uint64]string{1: "A", 2: "A2", 3: "A3"}}},
				}
			},
			want: "not adjacent",
		},
		{
			name: "overlay unknown branch path",
			ast: func() *AST {
				return &AST{
					Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
						{Path: "KIND", Kind: UnsignedDisplay, Digits: 1},
						{Path: "A", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
						{Path: "B", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
					}},
					Overlays: []Overlay{{Name: "O", Control: "KIND", Branches: map[uint64]string{1: "A", 2: "MISSING"}}},
				}
			},
			want: "does not exist",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Compile(tt.ast())
			if err == nil {
				t.Fatal("Compile accepted invalid AST")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want substring %q", err, tt.want)
			}
			var compileErr *CompileError
			if !asCompileError(err, &compileErr) {
				t.Fatalf("error = %T %v, want *CompileError", err, err)
			}
		})
	}
}

func asCompileError(err error, target **CompileError) bool {
	if err == nil {
		return false
	}
	if e, ok := err.(*CompileError); ok {
		*target = e
		return true
	}
	return false
}
