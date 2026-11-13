package dataeng

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Kind is the Avro type of a schema.
type Kind string

const (
	Null    Kind = "null"
	Boolean Kind = "boolean"
	Int     Kind = "int"
	Long    Kind = "long"
	Float   Kind = "float"
	Double  Kind = "double"
	Bytes   Kind = "bytes"
	String  Kind = "string"
	Record  Kind = "record"
	Enum    Kind = "enum"
	Array   Kind = "array"
	Map     Kind = "map"
	Union   Kind = "union"
	Fixed   Kind = "fixed"
)

// IsPrimitive reports whether k is one of Avro's primitive types.
func (k Kind) IsPrimitive() bool {
	switch k {
	case Null, Boolean, Int, Long, Float, Double, Bytes, String:
		return true
	default:
		return false
	}
}

// String returns the Avro name of the type.
func (k Kind) String() string { return string(k) }

// Field describes a record field.
type Field struct {
	Name    string
	Type    *Schema
	Aliases []string
	Doc     string

	// Default is the JSON default value decoded with json.Number for numeric
	// literals. It is only meaningful when HasDefault is true.
	Default any
	// DefaultJSON is the raw JSON representation of Default.
	DefaultJSON json.RawMessage
	HasDefault  bool
	Order       string
}

// DefaultValue interprets the field's JSON default using its schema type.
func (f *Field) DefaultValue() (any, error) {
	if f == nil {
		return nil, errors.New("nil field")
	}
	if !f.HasDefault {
		return nil, fmt.Errorf("field %q has no default", f.Name)
	}
	return DefaultValue(f.Type, f.Default)
}

// Schema is a parsed Avro schema. Named schemas are canonicalised by the
// parser: references to a previously defined name point at the same *Schema.
// This makes recursive schemas a finite reference graph rather than an
// infinitely expanded tree.
type Schema struct {
	Type Kind

	// Name is the unqualified name for named types.
	Name string
	// Namespace is the namespace of a named type.
	Namespace string
	// FullName is Name qualified by Namespace.
	FullName string
	// Aliases contains fully qualified alternative names.
	Aliases []string
	// Doc is the optional documentation string.
	Doc string
	// LogicalType is preserved for informational purposes. Resolution follows
	// the underlying Avro type.
	LogicalType string

	// Fields is populated for records (including "error" records).
	Fields []*Field
	// Symbols and EnumDefault are populated for enums.
	Symbols        []string
	EnumDefault    string
	HasEnumDefault bool

	// Items and Values are populated for arrays and maps.
	Items  *Schema
	Values *Schema
	// Branches is populated for unions.
	Branches []*Schema
	// Size is populated for fixed.
	Size int64
}

// IsNamed reports whether s is a named Avro type.
func (s *Schema) IsNamed() bool {
	if s == nil {
		return false
	}
	switch s.Type {
	case Record, Enum, Fixed:
		return true
	default:
		return false
	}
}

// Branch returns union branch i, or nil when i is out of range.
func (s *Schema) Branch(i int) *Schema {
	if s == nil || s.Type != Union || i < 0 || i >= len(s.Branches) {
		return nil
	}
	return s.Branches[i]
}

// Field returns the record field with the given name, or nil.
func (s *Schema) Field(name string) *Field {
	if s == nil || s.Type != Record {
		return nil
	}
	for _, field := range s.Fields {
		if field.Name == name {
			return field
		}
	}
	return nil
}

// String returns a compact, cycle-safe description of the schema.
func (s *Schema) String() string {
	return s.describe(make(map[*Schema]bool))
}

func (s *Schema) describe(seen map[*Schema]bool) string {
	if s == nil {
		return "<nil>"
	}
	switch s.Type {
	case Record:
		if seen[s] {
			return s.FullName
		}
		seen[s] = true
		var b strings.Builder
		b.WriteString("record ")
		b.WriteString(s.FullName)
		b.WriteString("{")
		for i, f := range s.Fields {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(f.Name)
			b.WriteString(": ")
			b.WriteString(f.Type.describe(seen))
		}
		b.WriteString("}")
		delete(seen, s)
		return b.String()
	case Enum:
		return "enum " + s.FullName + "{" + strings.Join(s.Symbols, ",") + "}"
	case Fixed:
		return fmt.Sprintf("fixed %s(%d)", s.FullName, s.Size)
	case Array:
		return "array<" + s.Items.describe(seen) + ">"
	case Map:
		return "map<" + s.Values.describe(seen) + ">"
	case Union:
		parts := make([]string, len(s.Branches))
		for i, branch := range s.Branches {
			parts[i] = branch.describe(seen)
		}
		return "union[" + strings.Join(parts, ",") + "]"
	default:
		if s.LogicalType != "" {
			return string(s.Type) + "(" + s.LogicalType + ")"
		}
		return string(s.Type)
	}
}

// ParseSchema parses a single Avro schema from JSON.
func ParseSchema(data []byte) (*Schema, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()

	var value any
	if err := dec.Decode(&value); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("avro: empty schema")
		}
		return nil, fmt.Errorf("avro: decode schema: %w", err)
	}

	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("avro: trailing data after schema")
		}
		return nil, fmt.Errorf("avro: decode schema: %w", err)
	}

	p := &parser{names: make(map[string]*Schema)}
	s, err := p.parse(value, "", 0)
	if err != nil {
		return nil, err
	}
	return s, nil
}

// ParseSchemaString parses a single Avro schema from a JSON string.
func ParseSchemaString(s string) (*Schema, error) {
	return ParseSchema([]byte(s))
}

type parser struct {
	names map[string]*Schema
}

func (p *parser) parse(value any, namespace string, depth int) (*Schema, error) {
	if depth > 1000 {
		return nil, errors.New("avro: schema nesting too deep")
	}
	switch v := value.(type) {
	case string:
		return p.typeName(v, namespace)
	case []any:
		return p.union(v, namespace, depth)
	case map[string]any:
		return p.object(v, namespace, depth)
	default:
		return nil, fmt.Errorf("avro: schema must be a JSON string, object or array, got %T", value)
	}
}

func (p *parser) typeName(name, namespace string) (*Schema, error) {
	if k := primitiveKind(name); k != "" {
		return &Schema{Type: k}, nil
	}
	full, err := resolveReferenceName(name, namespace)
	if err != nil {
		return nil, err
	}
	if s := p.names[full]; s != nil {
		return s, nil
	}
	return nil, fmt.Errorf("avro: unknown schema name %q", full)
}

func (p *parser) object(obj map[string]any, namespace string, depth int) (*Schema, error) {
	rawType, ok := obj["type"]
	if !ok {
		return nil, errors.New("avro: schema object has no type")
	}

	switch t := rawType.(type) {
	case string:
		switch t {
		case "record", "error":
			return p.record(obj, namespace, depth, t == "error")
		case "enum":
			return p.enum(obj, namespace, depth)
		case "array":
			return p.array(obj, namespace, depth)
		case "map":
			return p.mapSchema(obj, namespace, depth)
		case "fixed":
			return p.fixed(obj, namespace, depth)
		}
		if k := primitiveKind(t); k != "" {
			logical, err := optionalString(obj, "logicalType")
			if err != nil {
				return nil, err
			}
			return &Schema{Type: k, LogicalType: logical}, nil
		}
		// Avro permits the object form of a named reference.
		return p.typeName(t, namespace)
	case []any:
		return p.union(t, namespace, depth)
	case map[string]any:
		return p.object(t, namespace, depth)
	default:
		return nil, fmt.Errorf("avro: invalid type property %T", rawType)
	}
}

func (p *parser) record(obj map[string]any, namespace string, depth int, isError bool) (*Schema, error) {
	rawName, ok := obj["name"]
	if !ok {
		return nil, errors.New("avro: record has no name")
	}
	name, ok := rawName.(string)
	if !ok {
		return nil, errors.New("avro: record name is not a string")
	}
	explicitNS, hasNamespace, err := optionalStringPresent(obj, "namespace")
	if err != nil {
		return nil, err
	}
	doc, err := optionalString(obj, "doc")
	if err != nil {
		return nil, err
	}
	full, simple, ns, err := qualifyName(name, hasNamespace, explicitNS, namespace)
	if err != nil {
		return nil, err
	}
	aliases, err := p.aliases(obj, ns)
	if err != nil {
		return nil, err
	}
	if existing := p.names[full]; existing != nil {
		return nil, fmt.Errorf("avro: duplicate schema name %q", full)
	}

	s := &Schema{
		Type:      Record,
		Name:      simple,
		Namespace: ns,
		FullName:  full,
		Aliases:   aliases,
		Doc:       doc,
	}
	if isError {
		s.LogicalType = "error"
	}
	// Register before parsing fields so that recursive references resolve to
	// this very object.
	p.names[full] = s

	rawFields, ok := obj["fields"]
	if !ok {
		return nil, fmt.Errorf("avro: record %q has no fields", full)
	}
	fields, ok := rawFields.([]any)
	if !ok {
		return nil, fmt.Errorf("avro: record %q fields is not an array", full)
	}

	fieldNames := make(map[string]bool, len(fields))
	for i, rawField := range fields {
		fieldObj, ok := rawField.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("avro: record %q field %d is not an object", full, i)
		}
		rawFieldName, ok := fieldObj["name"]
		if !ok {
			return nil, fmt.Errorf("avro: record %q field %d has no name", full, i)
		}
		fieldName, ok := rawFieldName.(string)
		if !ok {
			return nil, fmt.Errorf("avro: record %q field %d name is not a string", full, i)
		}
		if !simpleNameRE.MatchString(fieldName) {
			return nil, fmt.Errorf("avro: invalid field name %q in record %q", fieldName, full)
		}
		if fieldNames[fieldName] {
			return nil, fmt.Errorf("avro: duplicate field %q in record %q", fieldName, full)
		}
		fieldNames[fieldName] = true

		rawFieldType, ok := fieldObj["type"]
		if !ok {
			return nil, fmt.Errorf("avro: field %q in record %q has no type", fieldName, full)
		}
		fieldType, err := p.parse(rawFieldType, ns, depth+1)
		if err != nil {
			return nil, fmt.Errorf("avro: field %q in record %q: %w", fieldName, full, err)
		}

		field := &Field{
			Name:  fieldName,
			Type:  fieldType,
			Order: "ascending",
		}
		if rawDoc, ok := fieldObj["doc"]; ok {
			doc, ok := rawDoc.(string)
			if !ok {
				return nil, fmt.Errorf("avro: field %q doc is not a string", fieldName)
			}
			field.Doc = doc
		}
		if rawOrder, ok := fieldObj["order"]; ok {
			order, ok := rawOrder.(string)
			if !ok {
				return nil, fmt.Errorf("avro: field %q order is not a string", fieldName)
			}
			switch order {
			case "ascending", "descending", "ignore":
				field.Order = order
			default:
				return nil, fmt.Errorf("avro: invalid order %q for field %q", order, fieldName)
			}
		}
		if rawAliases, ok := fieldObj["aliases"]; ok {
			aliasValues, ok := rawAliases.([]any)
			if !ok {
				return nil, fmt.Errorf("avro: field %q aliases is not an array", fieldName)
			}
			for _, rawAlias := range aliasValues {
				alias, ok := rawAlias.(string)
				if !ok || !simpleNameRE.MatchString(alias) {
					return nil, fmt.Errorf("avro: invalid alias for field %q", fieldName)
				}
				field.Aliases = append(field.Aliases, alias)
			}
		}
		if rawDefault, ok := fieldObj["default"]; ok {
			field.HasDefault = true
			field.Default = rawDefault
			rawJSON, err := json.Marshal(rawDefault)
			if err != nil {
				return nil, fmt.Errorf("avro: field %q default: %w", fieldName, err)
			}
			field.DefaultJSON = append(json.RawMessage(nil), rawJSON...)
		}
		s.Fields = append(s.Fields, field)
	}
	return s, nil
}

func (p *parser) enum(obj map[string]any, namespace string, _ int) (*Schema, error) {
	rawName, ok := obj["name"]
	if !ok {
		return nil, errors.New("avro: enum has no name")
	}
	name, ok := rawName.(string)
	if !ok {
		return nil, errors.New("avro: enum name is not a string")
	}
	explicitNS, hasNamespace, err := optionalStringPresent(obj, "namespace")
	if err != nil {
		return nil, err
	}
	doc, err := optionalString(obj, "doc")
	if err != nil {
		return nil, err
	}
	full, simple, ns, err := qualifyName(name, hasNamespace, explicitNS, namespace)
	if err != nil {
		return nil, err
	}
	aliases, err := p.aliases(obj, ns)
	if err != nil {
		return nil, err
	}
	if existing := p.names[full]; existing != nil {
		return nil, fmt.Errorf("avro: duplicate schema name %q", full)
	}

	rawSymbols, ok := obj["symbols"]
	if !ok {
		return nil, fmt.Errorf("avro: enum %q has no symbols", full)
	}
	symbolValues, ok := rawSymbols.([]any)
	if !ok {
		return nil, fmt.Errorf("avro: enum %q symbols is not an array", full)
	}
	if len(symbolValues) == 0 {
		return nil, fmt.Errorf("avro: enum %q has no symbols", full)
	}
	s := &Schema{
		Type:      Enum,
		Name:      simple,
		Namespace: ns,
		FullName:  full,
		Aliases:   aliases,
		Doc:       doc,
	}
	p.names[full] = s

	symbols := make(map[string]bool, len(symbolValues))
	for _, rawSymbol := range symbolValues {
		symbol, ok := rawSymbol.(string)
		if !ok || !simpleNameRE.MatchString(symbol) {
			return nil, fmt.Errorf("avro: enum %q has invalid symbol %v", full, rawSymbol)
		}
		if symbols[symbol] {
			return nil, fmt.Errorf("avro: enum %q has duplicate symbol %q", full, symbol)
		}
		symbols[symbol] = true
		s.Symbols = append(s.Symbols, symbol)
	}
	if rawDefault, ok := obj["default"]; ok {
		def, ok := rawDefault.(string)
		if !ok {
			return nil, fmt.Errorf("avro: enum %q default is not a string", full)
		}
		if !symbols[def] {
			return nil, fmt.Errorf("avro: enum %q default %q is not a symbol", full, def)
		}
		s.EnumDefault = def
		s.HasEnumDefault = true
	}
	return s, nil
}

func (p *parser) array(obj map[string]any, namespace string, depth int) (*Schema, error) {
	rawItems, ok := obj["items"]
	if !ok {
		return nil, errors.New("avro: array has no items")
	}
	items, err := p.parse(rawItems, namespace, depth+1)
	if err != nil {
		return nil, fmt.Errorf("avro: array items: %w", err)
	}
	return &Schema{Type: Array, Items: items}, nil
}

func (p *parser) mapSchema(obj map[string]any, namespace string, depth int) (*Schema, error) {
	rawValues, ok := obj["values"]
	if !ok {
		return nil, errors.New("avro: map has no values")
	}
	values, err := p.parse(rawValues, namespace, depth+1)
	if err != nil {
		return nil, fmt.Errorf("avro: map values: %w", err)
	}
	return &Schema{Type: Map, Values: values}, nil
}

func (p *parser) fixed(obj map[string]any, namespace string, _ int) (*Schema, error) {
	rawName, ok := obj["name"]
	if !ok {
		return nil, errors.New("avro: fixed has no name")
	}
	name, ok := rawName.(string)
	if !ok {
		return nil, errors.New("avro: fixed name is not a string")
	}
	explicitNS, hasNamespace, err := optionalStringPresent(obj, "namespace")
	if err != nil {
		return nil, err
	}
	doc, err := optionalString(obj, "doc")
	if err != nil {
		return nil, err
	}
	full, simple, ns, err := qualifyName(name, hasNamespace, explicitNS, namespace)
	if err != nil {
		return nil, err
	}
	aliases, err := p.aliases(obj, ns)
	if err != nil {
		return nil, err
	}
	if existing := p.names[full]; existing != nil {
		return nil, fmt.Errorf("avro: duplicate schema name %q", full)
	}
	rawSize, ok := obj["size"]
	if !ok {
		return nil, fmt.Errorf("avro: fixed %q has no size", full)
	}
	size, err := asInt64(rawSize)
	if err != nil || size < 0 {
		return nil, fmt.Errorf("avro: fixed %q has invalid size", full)
	}
	s := &Schema{
		Type:      Fixed,
		Name:      simple,
		Namespace: ns,
		FullName:  full,
		Aliases:   aliases,
		Doc:       doc,
		Size:      size,
	}
	p.names[full] = s
	return s, nil
}

func (p *parser) union(values []any, namespace string, depth int) (*Schema, error) {
	if len(values) == 0 {
		return nil, errors.New("avro: union has no branches")
	}
	s := &Schema{Type: Union}
	seen := make(map[string]bool, len(values))
	for i, rawBranch := range values {
		if _, isUnion := rawBranch.([]any); isUnion {
			return nil, errors.New("avro: unions may not contain unions")
		}
		branch, err := p.parse(rawBranch, namespace, depth+1)
		if err != nil {
			return nil, fmt.Errorf("avro: union branch %d: %w", i, err)
		}
		if branch.Type == Union {
			return nil, errors.New("avro: unions may not contain unions")
		}
		key := branch.Type.String()
		if branch.IsNamed() {
			key = "named:" + branch.FullName
		}
		if seen[key] {
			return nil, fmt.Errorf("avro: union has duplicate branch type %s", key)
		}
		seen[key] = true
		s.Branches = append(s.Branches, branch)
	}
	return s, nil
}

func (p *parser) aliases(obj map[string]any, namespace string) ([]string, error) {
	rawAliases, ok := obj["aliases"]
	if !ok {
		return nil, nil
	}
	values, ok := rawAliases.([]any)
	if !ok {
		return nil, errors.New("avro: aliases is not an array")
	}
	seen := make(map[string]bool, len(values))
	aliases := make([]string, 0, len(values))
	for _, rawAlias := range values {
		alias, ok := rawAlias.(string)
		if !ok {
			return nil, errors.New("avro: alias is not a string")
		}
		full, _, _, err := qualifyName(alias, false, "", namespace)
		if err != nil {
			return nil, fmt.Errorf("avro: invalid alias %q: %w", alias, err)
		}
		if !seen[full] {
			seen[full] = true
			aliases = append(aliases, full)
		}
	}
	return aliases, nil
}

var (
	nameRE       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
	simpleNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

func primitiveKind(name string) Kind {
	switch Kind(name) {
	case Null, Boolean, Int, Long, Float, Double, Bytes, String:
		return Kind(name)
	default:
		return ""
	}
}

func qualifyName(name string, hasExplicitNS bool, explicitNS, enclosingNS string) (full, simple, namespace string, err error) {
	if !nameRE.MatchString(name) {
		return "", "", "", fmt.Errorf("invalid name %q", name)
	}
	if strings.Contains(name, ".") {
		parts := strings.Split(name, ".")
		simple = parts[len(parts)-1]
		full = name
		namespace = strings.Join(parts[:len(parts)-1], ".")
		return full, simple, namespace, nil
	}
	if hasExplicitNS && explicitNS != "" && !nameRE.MatchString(explicitNS) {
		return "", "", "", fmt.Errorf("invalid namespace %q", explicitNS)
	}
	if hasExplicitNS {
		namespace = explicitNS
	} else {
		namespace = enclosingNS
	}
	simple = name
	if namespace == "" {
		return simple, simple, "", nil
	}
	full = namespace + "." + simple
	return full, simple, namespace, nil
}

func resolveReferenceName(name, namespace string) (string, error) {
	if !nameRE.MatchString(name) {
		return "", fmt.Errorf("avro: invalid schema name %q", name)
	}
	if strings.Contains(name, ".") || namespace == "" {
		return name, nil
	}
	return namespace + "." + name, nil
}

func optionalString(obj map[string]any, key string) (string, error) {
	value, _, err := optionalStringPresent(obj, key)
	return value, err
}

func optionalStringPresent(obj map[string]any, key string) (string, bool, error) {
	raw, ok := obj[key]
	if !ok {
		return "", false, nil
	}
	value, ok := raw.(string)
	if !ok {
		return "", true, fmt.Errorf("avro: %s is not a string", key)
	}
	return value, true, nil
}

func asInt64(value any) (int64, error) {
	switch v := value.(type) {
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			return 0, err
		}
		return i, nil
	case int:
		return int64(v), nil
	case int64:
		return v, nil
	case float64:
		if v != float64(int64(v)) {
			return 0, errors.New("not an integer")
		}
		return int64(v), nil
	default:
		return 0, fmt.Errorf("not an integer: %T", value)
	}
}
