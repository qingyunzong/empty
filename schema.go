// Package dataeng validates finite, acyclic JSON trees against a
// composable schema AST.
//
// The AST distinguishes anyOf (at least one branch passes) from oneOf
// (exactly one branch passes), supports named, possibly recursive
// references, and reports the value path together with a branch decision
// tree for every validation failure.
package dataeng

import (
	"fmt"
	"reflect"
)

// Schema is a node in the schema AST. All concrete implementations are
// pointer structs exported from this package; the interface is sealed so
// interpreters can rely on a closed set of node kinds.
type Schema interface {
	schemaMarker()
}

// Null matches the JSON null value (a Go nil interface value).
type Null struct{}

// Boolean matches JSON booleans (Go bool).
type Boolean struct{}

// Integer matches integral values in the signed int64 range that fall
// within the optional [Min, Max] interval. A nil bound means the bound is
// not enforced.
type Integer struct {
	Min *int64
	Max *int64
}

// String matches JSON strings whose value appears in Enumeration. An
// empty enumeration rejects every string.
type String struct {
	Enumeration []string
}

// ObjectProperty binds a fixed property name to the schema its values
// must satisfy.
type ObjectProperty struct {
	Name   string
	Schema Schema
}

// Object matches JSON objects with a fixed set of declared properties.
// Properties listed in Required must be present. When AdditionalProperties
// is false any property not declared in Properties is rejected; when true
// undeclared properties are accepted without further validation.
type Object struct {
	Properties           []ObjectProperty
	Required             []string
	AdditionalProperties bool
}

// Array matches JSON arrays. Items constrains every element and MinLength
// and MaxLength optionally bound the number of elements; nil means the
// corresponding bound is not enforced.
type Array struct {
	Items     Schema
	MinLength *int
	MaxLength *int
}

// AnyOf matches when at least one branch matches the value.
type AnyOf struct {
	Branches []Schema
}

// AllOf matches when every branch matches the value.
type AllOf struct {
	Branches []Schema
}

// OneOf matches when exactly one branch matches the value. Every branch
// is evaluated; matching stops on no branch and on two or more branches.
type OneOf struct {
	Branches []Schema
}

// Ref resolves to the named schema stored in the registry passed to
// Compile. References may be recursive.
type Ref struct {
	Name string
}

func (*Null) schemaMarker()    {}
func (*Boolean) schemaMarker() {}
func (*Integer) schemaMarker() {}
func (*String) schemaMarker()  {}
func (*Object) schemaMarker()  {}
func (*Array) schemaMarker()   {}
func (*AnyOf) schemaMarker()   {}
func (*AllOf) schemaMarker()   {}
func (*OneOf) schemaMarker()   {}
func (*Ref) schemaMarker()     {}

// SchemaError describes a defect discovered while compiling the schema
// graph, such as an unresolved reference or a forbidden cycle.
type SchemaError struct {
	// Path is the path of schema nodes from the root to the defect.
	Path []Schema
	// Reason is a machine-readable error code.
	Reason string
	// Message is a human-readable description.
	Message string
}

func (e *SchemaError) Error() string {
	return "dataeng: schema error: " + e.Message
}

// Reason codes returned in SchemaError.Reason.
const (
	ReasonNilSchema         = "nil_schema"
	ReasonUnresolvedRef     = "unresolved_ref"
	ReasonEmptyBranches     = "empty_branches"
	ReasonDuplicateRequired = "duplicate_required"
	ReasonUnknownRequired   = "unknown_required_property"
	ReasonGuardCycle        = "guard_cycle"
)

// Validator is a compiled schema ready to validate JSON values.
type Validator interface {
	// Validate checks value, which must be a finite, acyclic tree built
	// from nil, bool, int64 (and other Go integer kinds), float64,
	// json.Number, string, []any and map[string]any. A nil *Failure
	// result means validation succeeded.
	Validate(value any) *Failure
}

type compiledValidator struct {
	root Schema
	defs map[string]Schema
}

// Compile performs all up-front checks of the schema graph rooted at root
// and returns a Validator backed by the supplied named definitions.
//
// Every node reachable from root must be non-nil, every Ref must resolve
// through defs, and the subgraph formed solely by reference and
// anyOf/allOf/oneOf edges must be acyclic. Edges that descend into object
// properties or array items do not participate in cycle detection, so
// recursive references behind those edges are allowed.
func Compile(root Schema, defs map[string]Schema) (Validator, error) {
	if root == nil {
		return nil, &SchemaError{
			Reason:  ReasonNilSchema,
			Message: "root schema is nil",
		}
	}

	reachable, order, err := reachableNodes(root, defs)
	if err != nil {
		return nil, err
	}

	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[uintptr]int, len(reachable))
	var stack []Schema

	var visit func(schema Schema) *SchemaError
	visit = func(schema Schema) *SchemaError {
		key := nodeKey(schema)
		switch color[key] {
		case gray:
			cycleStart := indexOfSchema(stack, schema)
			cyclePath := append(append([]Schema{}, stack[cycleStart:]...), schema)
			return &SchemaError{
				Path:   cyclePath,
				Reason: ReasonGuardCycle,
				Message: fmt.Sprintf(
					"guard edge cycle detected through %s",
					describeCycle(cyclePath),
				),
			}
		case black:
			return nil
		}
		color[key] = gray
		stack = append(stack, schema)
		for _, next := range guardEdges(schema, defs) {
			if err := visit(next); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		color[key] = black
		return nil
	}

	for _, schema := range order {
		if err := visit(schema); err != nil {
			return nil, err
		}
	}

	return &compiledValidator{root: root, defs: defs}, nil
}

func reachableNodes(root Schema, defs map[string]Schema) (map[uintptr]Schema, []Schema, *SchemaError) {
	reachable := make(map[uintptr]Schema)
	var order []Schema

	var visit func(schema Schema, trail []Schema) *SchemaError
	visit = func(schema Schema, trail []Schema) *SchemaError {
		if schema == nil {
			return &SchemaError{
				Path:    append(append([]Schema{}, trail...), nil),
				Reason:  ReasonNilSchema,
				Message: "nil schema reached from root",
			}
		}
		key := nodeKey(schema)
		if _, seen := reachable[key]; seen {
			return nil
		}
		reachable[key] = schema
		order = append(order, schema)
		nextTrail := append(append([]Schema{}, trail...), schema)

		switch node := schema.(type) {
		case *Ref:
			target, ok := defs[node.Name]
			if !ok {
				return &SchemaError{
					Path:    append(append([]Schema{}, nextTrail...), nil),
					Reason:  ReasonUnresolvedRef,
					Message: fmt.Sprintf("unresolved reference %q", node.Name),
				}
			}
			if err := visit(target, nextTrail); err != nil {
				return err
			}
		case *Object:
			declared := make(map[string]struct{}, len(node.Properties))
			for _, property := range node.Properties {
				if property.Schema == nil {
					return &SchemaError{
						Path:    append(append([]Schema{}, nextTrail...), nil),
						Reason:  ReasonNilSchema,
						Message: fmt.Sprintf("object property %q has nil schema", property.Name),
					}
				}
				declared[property.Name] = struct{}{}
			}
			seenRequired := make(map[string]struct{}, len(node.Required))
			for _, name := range node.Required {
				if _, duplicated := seenRequired[name]; duplicated {
					return &SchemaError{
						Path:    nextTrail,
						Reason:  ReasonDuplicateRequired,
						Message: fmt.Sprintf("object declares required property %q more than once", name),
					}
				}
				seenRequired[name] = struct{}{}
				if _, ok := declared[name]; !ok {
					return &SchemaError{
						Path:    nextTrail,
						Reason:  ReasonUnknownRequired,
						Message: fmt.Sprintf("required property %q is not declared in object properties", name),
					}
				}
			}
			for _, property := range node.Properties {
				if err := visit(property.Schema, nextTrail); err != nil {
					return err
				}
			}
		case *Array:
			if node.Items == nil {
				return &SchemaError{
					Path:    append(append([]Schema{}, nextTrail...), nil),
					Reason:  ReasonNilSchema,
					Message: "array item schema is nil",
				}
			}
			if err := visit(node.Items, nextTrail); err != nil {
				return err
			}
		case *AnyOf:
			if len(node.Branches) == 0 {
				return &SchemaError{
					Path:    nextTrail,
					Reason:  ReasonEmptyBranches,
					Message: "anyOf must declare at least one branch",
				}
			}
			for _, branch := range node.Branches {
				if err := visit(branch, nextTrail); err != nil {
					return err
				}
			}
		case *AllOf:
			if len(node.Branches) == 0 {
				return &SchemaError{
					Path:    nextTrail,
					Reason:  ReasonEmptyBranches,
					Message: "allOf must declare at least one branch",
				}
			}
			for _, branch := range node.Branches {
				if err := visit(branch, nextTrail); err != nil {
					return err
				}
			}
		case *OneOf:
			if len(node.Branches) == 0 {
				return &SchemaError{
					Path:    nextTrail,
					Reason:  ReasonEmptyBranches,
					Message: "oneOf must declare at least one branch",
				}
			}
			for _, branch := range node.Branches {
				if err := visit(branch, nextTrail); err != nil {
					return err
				}
			}
		}
		return nil
	}

	if err := visit(root, nil); err != nil {
		return nil, nil, err
	}
	return reachable, order, nil
}

// guardEdges returns the edges that participate in compile-time cycle
// detection: references and combinator branches. Object property and
// array item edges descend into a new JSON value and are excluded.
// The reachability pass guarantees that every reference resolves.
func guardEdges(schema Schema, defs map[string]Schema) []Schema {
	switch node := schema.(type) {
	case *Ref:
		return []Schema{defs[node.Name]}
	case *AnyOf, *AllOf, *OneOf:
		return branchesOf(node)
	default:
		return nil
	}
}

// refTarget is wired by the validator's registry; the compile-time graph
// check resolves refs through the same map.
func branchesOf(schema Schema) []Schema {
	switch node := schema.(type) {
	case *AnyOf:
		return node.Branches
	case *AllOf:
		return node.Branches
	case *OneOf:
		return node.Branches
	default:
		return nil
	}
}

func nodeKey(schema Schema) uintptr {
	value := reflect.ValueOf(schema)
	if value.Kind() != reflect.Ptr {
		panic(fmt.Sprintf("dataeng: schema node %T is not a pointer", schema))
	}
	return value.Pointer()
}

func indexOfSchema(stack []Schema, target Schema) int {
	key := nodeKey(target)
	for i, schema := range stack {
		if nodeKey(schema) == key {
			return i
		}
	}
	return -1
}

func describeCycle(path []Schema) string {
	description := ""
	for i, schema := range path {
		if i > 0 {
			description += " -> "
		}
		description += label(schema)
	}
	return description
}
