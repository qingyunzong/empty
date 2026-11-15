package dataeng

import (
	"encoding/json"
	"fmt"
	"strings"
)

// parser holds the symbol table for a single schema document. Named types
// imported from referenced registry schemas are pre-seeded into names.
type parser struct {
	names map[string]Named
}

// parseSchema parses one Avro schema JSON document. imports maps fullnames
// (and reference names) to named types supplied by referenced schemas.
// It returns the root type and the full named-type symbol table, including
// imports, i.e. the named-type closure of the document.
func parseSchema(raw string, imports map[string]Named) (Type, map[string]Named, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, nil, fmt.Errorf("avro: invalid schema JSON: %w", err)
	}
	p := &parser{names: make(map[string]Named, len(imports)+8)}
	for n, t := range imports {
		p.names[n] = t
	}
	root, err := p.parse(doc, "")
	if err != nil {
		return nil, nil, err
	}
	return root, p.names, nil
}

func (p *parser) parse(v any, ns string) (Type, error) {
	switch v := v.(type) {
	case string:
		return p.parseName(v, ns)
	case []any:
		return p.parseUnion(v, ns)
	case map[string]any:
		tv, ok := v["type"]
		if !ok {
			return nil, fmt.Errorf("avro: schema object missing \"type\"")
		}
		ts, ok := tv.(string)
		if !ok {
			// {"type": <schema object or union>, ...extra attrs}: parse the
			// nested schema, extra attributes (e.g. logicalType) are ignored.
			return p.parse(tv, ns)
		}
		switch ts {
		case "record", "error":
			return p.parseRecord(v, ns)
		case "enum":
			return p.parseEnum(v, ns)
		case "array":
			iv, ok := v["items"]
			if !ok {
				return nil, fmt.Errorf("avro: array schema missing \"items\"")
			}
			items, err := p.parse(iv, ns)
			if err != nil {
				return nil, err
			}
			return &Array{Items: items}, nil
		case "map":
			vv, ok := v["values"]
			if !ok {
				return nil, fmt.Errorf("avro: map schema missing \"values\"")
			}
			values, err := p.parse(vv, ns)
			if err != nil {
				return nil, err
			}
			return &Map{Values: values}, nil
		case "fixed":
			return p.parseFixed(v, ns)
		default:
			// Primitive type with attributes (e.g. logicalType) or a named
			// type reference with extra attributes.
			return p.parseName(ts, ns)
		}
	default:
		return nil, fmt.Errorf("avro: invalid schema value of type %T", v)
	}
}

func (p *parser) parseName(name, ns string) (Type, error) {
	if isPrimitiveName(name) {
		return primitiveByName(name), nil
	}
	for _, cand := range resolveCandidates(name, ns) {
		if t, ok := p.names[cand]; ok {
			return t, nil
		}
	}
	return nil, fmt.Errorf("avro: unknown type name %q in namespace %q", name, ns)
}

// resolveCandidates lists the fullnames an unqualified reference may resolve
// to: the enclosing namespace first, then walking up to the null namespace.
func resolveCandidates(name, ns string) []string {
	if strings.Contains(name, ".") || ns == "" {
		return []string{name}
	}
	var out []string
	for cur := ns; cur != ""; {
		out = append(out, cur+"."+name)
		i := strings.LastIndex(cur, ".")
		if i < 0 {
			break
		}
		cur = cur[:i]
	}
	return append(out, name)
}

// typeFullname computes the fullname and own namespace of a named type
// definition per the Avro name rules: a dotted name is already a fullname
// (its "namespace" attribute is ignored); otherwise the explicit
// "namespace" attribute wins over the enclosing namespace; an empty
// namespace resets to the null namespace.
func typeFullname(m map[string]any, enclosingNS string) (full, ns string, err error) {
	name, ok := m["name"].(string)
	if !ok || name == "" {
		return "", "", fmt.Errorf("avro: named schema missing \"name\"")
	}
	if strings.Contains(name, ".") {
		return name, name[:strings.LastIndex(name, ".")], nil
	}
	ns = enclosingNS
	if explicit, ok := m["namespace"].(string); ok {
		ns = explicit
	}
	if ns == "" {
		return name, "", nil
	}
	return ns + "." + name, ns, nil
}

// typeAliases converts the "aliases" attribute of a named type to fullnames
// resolved against the type's own namespace.
func typeAliases(m map[string]any, ns string) []string {
	raw, ok := m["aliases"].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, a := range raw {
		s, ok := a.(string)
		if !ok {
			continue
		}
		if strings.Contains(s, ".") || ns == "" {
			out = append(out, s)
		} else {
			out = append(out, ns+"."+s)
		}
	}
	return out
}

func stringList(m map[string]any, key string) []string {
	raw, ok := m[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func (p *parser) parseRecord(m map[string]any, ns string) (Type, error) {
	full, recNS, err := typeFullname(m, ns)
	if err != nil {
		return nil, err
	}
	if _, dup := p.names[full]; dup {
		return nil, fmt.Errorf("avro: duplicate type name %q", full)
	}
	rec := &Record{Name: full, Aliases: typeAliases(m, recNS)}
	// Register before parsing fields so recursive references resolve.
	p.names[full] = rec

	rawFields, ok := m["fields"].([]any)
	if !ok {
		return nil, fmt.Errorf("avro: record %q missing \"fields\"", full)
	}
	seen := make(map[string]bool, len(rawFields))
	for i, rv := range rawFields {
		fm, ok := rv.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("avro: record %q field %d is not an object", full, i)
		}
		fname, _ := fm["name"].(string)
		if fname == "" {
			return nil, fmt.Errorf("avro: record %q field %d missing \"name\"", full, i)
		}
		if seen[fname] {
			return nil, fmt.Errorf("avro: record %q has duplicate field %q", full, fname)
		}
		seen[fname] = true
		ftv, ok := fm["type"]
		if !ok {
			return nil, fmt.Errorf("avro: field %q of record %q missing \"type\"", fname, full)
		}
		ft, err := p.parse(ftv, recNS)
		if err != nil {
			return nil, err
		}
		field := &Field{
			Name:    fname,
			Type:    ft,
			Aliases: stringList(fm, "aliases"),
		}
		if order, ok := fm["order"].(string); ok {
			field.Order = order
		}
		if dv, ok := fm["default"]; ok {
			field.HasDefault = true
			field.Default = dv
			if !validDefault(ft, dv) {
				return nil, fmt.Errorf("avro: field %q of record %q: default value does not match type %s", fname, full, typeLabel(ft))
			}
		}
		rec.Fields = append(rec.Fields, field)
	}
	return rec, nil
}

func (p *parser) parseEnum(m map[string]any, ns string) (Type, error) {
	full, enumNS, err := typeFullname(m, ns)
	if err != nil {
		return nil, err
	}
	if _, dup := p.names[full]; dup {
		return nil, fmt.Errorf("avro: duplicate type name %q", full)
	}
	rawSymbols, ok := m["symbols"].([]any)
	if !ok || len(rawSymbols) == 0 {
		return nil, fmt.Errorf("avro: enum %q missing \"symbols\"", full)
	}
	e := &Enum{Name: full, Aliases: typeAliases(m, enumNS)}
	seen := make(map[string]bool, len(rawSymbols))
	for _, sv := range rawSymbols {
		s, ok := sv.(string)
		if !ok {
			return nil, fmt.Errorf("avro: enum %q has a non-string symbol", full)
		}
		if seen[s] {
			return nil, fmt.Errorf("avro: enum %q has duplicate symbol %q", full, s)
		}
		seen[s] = true
		e.Symbols = append(e.Symbols, s)
	}
	if dv, ok := m["default"]; ok {
		s, ok := dv.(string)
		if !ok || !seen[s] {
			return nil, fmt.Errorf("avro: enum %q default is not one of its symbols", full)
		}
		e.Default = s
		e.HasDefault = true
	}
	p.names[full] = e
	return e, nil
}

func (p *parser) parseFixed(m map[string]any, ns string) (Type, error) {
	full, fixedNS, err := typeFullname(m, ns)
	if err != nil {
		return nil, err
	}
	if _, dup := p.names[full]; dup {
		return nil, fmt.Errorf("avro: duplicate type name %q", full)
	}
	size, err := intAttr(m, "size")
	if err != nil || size <= 0 {
		return nil, fmt.Errorf("avro: fixed %q has invalid \"size\"", full)
	}
	f := &Fixed{Name: full, Aliases: typeAliases(m, fixedNS), Size: size}
	p.names[full] = f
	return f, nil
}

func intAttr(m map[string]any, key string) (int, error) {
	switch v := m[key].(type) {
	case json.Number:
		n, err := v.Int64()
		return int(n), err
	case float64:
		return int(v), nil
	}
	return 0, fmt.Errorf("avro: missing integer attribute %q", key)
}

func (p *parser) parseUnion(list []any, ns string) (Type, error) {
	if len(list) == 0 {
		return nil, fmt.Errorf("avro: union must have at least one branch")
	}
	u := &Union{}
	seenKinds := make(map[Kind]bool)
	seenNames := make(map[string]bool)
	for _, bv := range list {
		bt, err := p.parse(bv, ns)
		if err != nil {
			return nil, err
		}
		if _, ok := bt.(*Union); ok {
			return nil, fmt.Errorf("avro: union may not immediately contain another union")
		}
		if n, ok := bt.(Named); ok {
			if seenNames[n.Fullname()] {
				return nil, fmt.Errorf("avro: duplicate type %q in union", n.Fullname())
			}
			seenNames[n.Fullname()] = true
		} else {
			k := bt.Kind()
			if seenKinds[k] {
				return nil, fmt.Errorf("avro: duplicate %s branch in union", k)
			}
			seenKinds[k] = true
		}
		u.Types = append(u.Types, bt)
	}
	return u, nil
}

// validDefault reports whether d is a valid default value for t. For unions
// the default must match the first branch, per the Avro specification.
func validDefault(t Type, d any) bool {
	switch t := t.(type) {
	case *Primitive:
		switch t.Kind() {
		case KindNull:
			return d == nil
		case KindBoolean:
			_, ok := d.(bool)
			return ok
		case KindInt, KindLong:
			n, ok := d.(json.Number)
			if !ok {
				return false
			}
			_, err := n.Int64()
			return err == nil
		case KindFloat, KindDouble:
			n, ok := d.(json.Number)
			if !ok {
				return false
			}
			_, err := n.Float64()
			return err == nil
		case KindString, KindBytes:
			_, ok := d.(string)
			return ok
		}
	case *Record:
		m, ok := d.(map[string]any)
		if !ok {
			return false
		}
		for _, f := range t.Fields {
			if fv, ok := m[f.Name]; ok {
				if !validDefault(f.Type, fv) {
					return false
				}
			} else if !f.HasDefault {
				return false
			}
		}
		return true
	case *Enum:
		s, ok := d.(string)
		if !ok {
			return false
		}
		for _, sym := range t.Symbols {
			if sym == s {
				return true
			}
		}
		return false
	case *Array:
		arr, ok := d.([]any)
		if !ok {
			return false
		}
		for _, e := range arr {
			if !validDefault(t.Items, e) {
				return false
			}
		}
		return true
	case *Map:
		m, ok := d.(map[string]any)
		if !ok {
			return false
		}
		for _, v := range m {
			if !validDefault(t.Values, v) {
				return false
			}
		}
		return true
	case *Union:
		return validDefault(t.Types[0], d)
	case *Fixed:
		s, ok := d.(string)
		return ok && len(s) == t.Size
	}
	return false
}
