package dataeng

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// Reason codes returned in Trace.Reason while validating values.
const (
	ReasonNotNull       = "not_null"
	ReasonNotBoolean    = "not_boolean"
	ReasonNotInteger    = "not_integer"
	ReasonIntegerRange  = "integer_out_of_range"
	ReasonNotString     = "not_string"
	ReasonEnumMismatch  = "string_not_in_enum"
	ReasonNotObject     = "not_object"
	ReasonMissingField  = "missing_required_field"
	ReasonExtraField    = "additional_field_not_allowed"
	ReasonFieldFailed   = "field_failed"
	ReasonNotArray      = "not_array"
	ReasonArrayTooShort = "array_too_short"
	ReasonArrayTooLong  = "array_too_long"
	ReasonElementFailed = "element_failed"
	ReasonAnyOfNoMatch  = "any_of_no_match"
	ReasonAllOfFailed   = "all_of_failed"
	ReasonOneOfNoMatch  = "one_of_no_match"
	ReasonOneOfMultiple = "one_of_multiple_matches"
	ReasonCyclicValue   = "cyclic_value"
)

// PathStep is one segment of a value path. Property steps hold object
// field names and index steps hold array positions.
type PathStep struct {
	// Property is the object field name; empty for array index steps.
	Property string
	// IsIndex reports whether the step indexes an array element.
	IsIndex bool
	// Index is the array position; meaningful only when IsIndex is true.
	Index int
}

// Path locates a node inside the validated JSON tree.
type Path []PathStep

// String renders the path as JSONPath-like notation, for example
// "$.items[2].name".
func (path Path) String() string {
	var builder strings.Builder
	builder.WriteByte('$')
	for _, step := range path {
		if step.IsIndex {
			builder.WriteByte('[')
			builder.WriteString(strconv.Itoa(step.Index))
			builder.WriteByte(']')
		} else {
			builder.WriteByte('.')
			builder.WriteString(step.Property)
		}
	}
	return builder.String()
}

// Trace is one node of the branch decision tree. Each evaluated schema
// node produces a trace; failing traces carry a machine-readable reason.
type Trace struct {
	// Schema is the AST node that was evaluated.
	Schema Schema
	// Reason is empty when the node matched; otherwise it holds a reason
	// code from this package.
	Reason string
	// Path is the value path at which the node was evaluated; refs and
	// leaf nodes always populate it.
	Path Path
	// BranchIndex is the index of this node within its parent
	// combinator, or -1 when the node is not a combinator branch.
	BranchIndex int
	// Children holds the decision tree produced by nested evaluation
	// (object fields, array elements, combinator branches or refs).
	Children []*Trace
}

// Failed reports whether the trace records a rejected node.
func (trace *Trace) Failed() bool {
	return trace != nil && trace.Reason != ""
}

// Failure describes a rejected value: the deepest value path reached by
// the interpreter plus the full branch decision tree.
type Failure struct {
	// Path is the deepest value path associated with the failure.
	Path Path
	// Trace is the root of the branch decision tree.
	Trace *Trace
}

func (failure *Failure) Error() string {
	return fmt.Sprintf(
		"dataeng: validation failed at %s: %s",
		failure.Path.String(),
		renderTrace(failure.Trace, 0),
	)
}

// interpreter is an independent recursive evaluator. It never mutates the
// schema AST and keeps all runtime state on its own call stack.
type interpreter struct {
	defs         map[string]Schema
	activeValues map[uintptr]struct{}
}

func (validator *compiledValidator) Validate(value any) *Failure {
	interp := &interpreter{
		defs:         validator.defs,
		activeValues: make(map[uintptr]struct{}),
	}
	trace := interp.eval(validator.root, value, Path{})
	if trace == nil || !trace.Failed() {
		return nil
	}
	return &Failure{
		Path:  deepestPath(trace),
		Trace: trace,
	}
}

// eval returns nil when schema matches value, otherwise a trace tree
// describing every evaluated branch. The passed path is copied before
// being stored, so callers may reuse their slice.
func (interp *interpreter) eval(schema Schema, value any, path Path) *Trace {
	trace := &Trace{
		Schema:      schema,
		BranchIndex: -1,
		Path:        append(Path{}, path...),
	}

	switch node := schema.(type) {
	case *Null:
		if value != nil {
			trace.Reason = ReasonNotNull
		}
	case *Boolean:
		if _, ok := value.(bool); !ok {
			trace.Reason = ReasonNotBoolean
		}
	case *Integer:
		integer, ok := toInt64(value)
		if !ok {
			trace.Reason = ReasonNotInteger
			break
		}
		if node.Min != nil && integer < *node.Min {
			trace.Reason = ReasonIntegerRange
			break
		}
		if node.Max != nil && integer > *node.Max {
			trace.Reason = ReasonIntegerRange
		}
	case *String:
		text, ok := value.(string)
		if !ok {
			trace.Reason = ReasonNotString
			break
		}
		if !stringIn(text, node.Enumeration) {
			trace.Reason = ReasonEnumMismatch
		}
	case *Object:
		interp.evalObject(node, value, path, trace)
	case *Array:
		interp.evalArray(node, value, path, trace)
	case *AnyOf:
		interp.evalAnyOf(node, value, path, trace)
	case *AllOf:
		interp.evalAllOf(node, value, path, trace)
	case *OneOf:
		interp.evalOneOf(node, value, path, trace)
	case *Ref:
		child := interp.eval(interp.defs[node.Name], value, path)
		trace.Children = append(trace.Children, child)
		if child.Failed() {
			trace.Reason = child.Reason
		}
	default:
		panic(fmt.Sprintf("dataeng: unknown schema node %T", schema))
	}

	if !trace.Failed() {
		return nil
	}
	return trace
}

func (interp *interpreter) evalObject(node *Object, value any, path Path, trace *Trace) {
	object, ok := value.(map[string]any)
	if !ok {
		trace.Reason = ReasonNotObject
		return
	}

	activeKey, cyclic := interp.enterValue(object)
	if cyclic {
		trace.Reason = ReasonCyclicValue
		return
	}
	defer interp.leaveValue(activeKey)

	for _, name := range node.Required {
		if _, present := object[name]; !present {
			trace.Children = append(trace.Children, &Trace{
				Schema:      node,
				Reason:      ReasonMissingField,
				Path:        append(append(Path{}, path...), PathStep{Property: name}),
				BranchIndex: -1,
			})
		}
	}

	declared := make(map[string]Schema, len(node.Properties))
	names := make([]string, 0, len(node.Properties))
	for _, property := range node.Properties {
		declared[property.Name] = property.Schema
		names = append(names, property.Name)
	}

	if !node.AdditionalProperties {
		extraNames := make([]string, 0)
		for name := range object {
			if _, known := declared[name]; !known {
				extraNames = append(extraNames, name)
			}
		}
		sort.Strings(extraNames)
		for _, name := range extraNames {
			trace.Children = append(trace.Children, &Trace{
				Schema:      node,
				Reason:      ReasonExtraField,
				Path:        append(append(Path{}, path...), PathStep{Property: name}),
				BranchIndex: -1,
			})
		}
	}

	sort.Strings(names)
	for _, name := range names {
		fieldValue, present := object[name]
		if !present {
			continue
		}
		childPath := append(append(Path{}, path...), PathStep{Property: name})
		if child := interp.eval(declared[name], fieldValue, childPath); child != nil {
			trace.Children = append(trace.Children, child)
		}
	}

	if len(trace.Children) > 0 {
		trace.Reason = ReasonFieldFailed
	}
}

func (interp *interpreter) evalArray(node *Array, value any, path Path, trace *Trace) {
	array, ok := value.([]any)
	if !ok {
		trace.Reason = ReasonNotArray
		return
	}

	activeKey, cyclic := interp.enterValue(array)
	if cyclic {
		trace.Reason = ReasonCyclicValue
		return
	}
	defer interp.leaveValue(activeKey)

	length := len(array)
	if node.MinLength != nil && length < *node.MinLength {
		trace.Children = append(trace.Children, &Trace{
			Schema:      node,
			Reason:      ReasonArrayTooShort,
			Path:        append(Path{}, path...),
			BranchIndex: -1,
		})
	}
	if node.MaxLength != nil && length > *node.MaxLength {
		trace.Children = append(trace.Children, &Trace{
			Schema:      node,
			Reason:      ReasonArrayTooLong,
			Path:        append(Path{}, path...),
			BranchIndex: -1,
		})
	}

	for index, element := range array {
		childPath := append(append(Path{}, path...), PathStep{IsIndex: true, Index: index})
		if child := interp.eval(node.Items, element, childPath); child != nil {
			trace.Children = append(trace.Children, child)
		}
	}

	if len(trace.Children) > 0 {
		trace.Reason = ReasonElementFailed
	}
}

func (interp *interpreter) evalAnyOf(node *AnyOf, value any, path Path, trace *Trace) {
	matches := interp.evalBranches(node.Branches, value, path, trace)
	if len(matches) == 0 {
		trace.Reason = ReasonAnyOfNoMatch
	}
}

func (interp *interpreter) evalAllOf(node *AllOf, value any, path Path, trace *Trace) {
	matches := interp.evalBranches(node.Branches, value, path, trace)
	if len(matches) != len(node.Branches) {
		trace.Reason = ReasonAllOfFailed
	}
}

func (interp *interpreter) evalOneOf(node *OneOf, value any, path Path, trace *Trace) {
	// oneOf requires exactly one matching branch, so every branch is
	// evaluated even after an earlier branch succeeds.
	matches := interp.evalBranches(node.Branches, value, path, trace)
	switch {
	case len(matches) == 0:
		trace.Reason = ReasonOneOfNoMatch
	case len(matches) > 1:
		trace.Reason = ReasonOneOfMultiple
	}
}

// evalBranches evaluates every branch without short-circuiting and
// returns the indexes of branches that matched.
func (interp *interpreter) evalBranches(branches []Schema, value any, path Path, trace *Trace) []int {
	matches := make([]int, 0, len(branches))
	for index, branch := range branches {
		child := interp.eval(branch, value, path)
		if child == nil {
			matches = append(matches, index)
			child = &Trace{
				Schema:      branch,
				Path:        append(Path{}, path...),
				BranchIndex: index,
			}
		} else {
			child.BranchIndex = index
		}
		trace.Children = append(trace.Children, child)
	}
	return matches
}

// enterValue guards against cyclic input values. Only map and slice
// headers can participate in a value cycle.
func (interp *interpreter) enterValue(value any) (uintptr, bool) {
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Map, reflect.Slice:
		key := reflected.Pointer()
		if _, active := interp.activeValues[key]; active {
			return 0, true
		}
		interp.activeValues[key] = struct{}{}
		return key, false
	default:
		return 0, false
	}
}

func (interp *interpreter) leaveValue(key uintptr) {
	if key == 0 {
		return
	}
	delete(interp.activeValues, key)
}

// toInt64 accepts signed and unsigned Go integers, integral float64
// values within the int64 range and integral json.Number values.
func toInt64(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int8:
		return int64(number), true
	case int16:
		return int64(number), true
	case int32:
		return int64(number), true
	case int64:
		return number, true
	case uint:
		if uint64(number) > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	case uint8:
		return int64(number), true
	case uint16:
		return int64(number), true
	case uint32:
		return int64(number), true
	case uint64:
		if number > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	case float32:
		return floatToInt64(float64(number))
	case float64:
		return floatToInt64(number)
	case json.Number:
		parsed, err := number.Float64()
		if err != nil {
			return 0, false
		}
		return floatToInt64(parsed)
	default:
		return 0, false
	}
}

func floatToInt64(number float64) (int64, bool) {
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	if math.Trunc(number) != number {
		return 0, false
	}
	if number < math.MinInt64 || number >= math.MaxInt64+1 {
		return 0, false
	}
	return int64(number), true
}

func stringIn(text string, options []string) bool {
	for _, option := range options {
		if option == text {
			return true
		}
	}
	return false
}

// label renders a compact, human-readable name for a schema node.
func label(schema Schema) string {
	switch node := schema.(type) {
	case *Null:
		return "null"
	case *Boolean:
		return "boolean"
	case *Integer:
		return "integer"
	case *String:
		return "string"
	case *Object:
		return "object"
	case *Array:
		return "array"
	case *AnyOf:
		return "anyOf"
	case *AllOf:
		return "allOf"
	case *OneOf:
		return "oneOf"
	case *Ref:
		return "ref(" + node.Name + ")"
	default:
		return fmt.Sprintf("%T", schema)
	}
}

// deepestPath walks the decision tree to the first leaf carrying the
// deepest value path, which is the most precise failure location.
func deepestPath(trace *Trace) Path {
	var best Path
	var walk func(*Trace)
	walk = func(node *Trace) {
		if node == nil {
			return
		}
		if len(node.Children) == 0 && len(node.Path) >= len(best) {
			best = node.Path
		}
		for _, child := range node.Children {
			walk(child)
		}
	}
	walk(trace)
	if best == nil && trace != nil {
		best = trace.Path
	}
	return best
}

func renderTrace(trace *Trace, depth int) string {
	if trace == nil {
		return ""
	}
	indent := strings.Repeat("  ", depth)
	status := "match"
	if trace.Failed() {
		status = "fail:" + trace.Reason
	}
	line := fmt.Sprintf("%s%s %s at %s", indent, label(trace.Schema), status, trace.Path.String())
	for _, child := range trace.Children {
		line += "\n" + renderTrace(child, depth+1)
	}
	return line
}
