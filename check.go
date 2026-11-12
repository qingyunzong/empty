package dataeng

import (
	"encoding/json"
	"fmt"
)

// jsonMarshalString isolates the standard encoder used for object keys.
func jsonMarshalString(s string) ([]byte, error) {
	return json.Marshal(s)
}

// compiledSchema keeps the name-sorted fields and caller-defined enum ranks.
type compiledSchema struct {
	fields []FieldSpec
	ranks  []map[int]int
	index  map[string]int
}

func compile(s *Schema) (*compiledSchema, error) {
	fields, err := validate(s)
	if err != nil {
		return nil, err
	}
	c := &compiledSchema{
		fields: fields,
		ranks:  make([]map[int]int, len(fields)),
		index:  make(map[string]int, len(fields)),
	}
	for i, f := range fields {
		c.index[f.Name] = i
		c.ranks[i] = make(map[int]int, len(f.Enum))
		for rank, v := range f.Enum {
			c.ranks[i][v] = rank
		}
	}
	return c, nil
}

// DomainSize returns the number of records in the finite schema domain.
// Each field contributes perFieldDomain present-value choices, plus one
// "key absent" choice when the field is optional.
func DomainSize(s *Schema) (uint64, error) {
	c, err := compile(s)
	if err != nil {
		return 0, err
	}
	return c.domainSize(), nil
}

func (c *compiledSchema) domainSize() uint64 {
	size := uint64(1)
	for _, f := range c.fields {
		choices := perFieldDomain(f)
		if !f.Required {
			choices++
		}
		size *= choices
	}
	return size
}

// perFieldDomain counts legal present values of one field.
func perFieldDomain(f FieldSpec) uint64 {
	switch f.Kind {
	case IntegerEnum:
		n := uint64(len(f.Enum))
		if f.Nullable {
			n++
		}
		return n
	case EnumArray:
		e := uint64(len(f.Enum))
		total := uint64(0)
		pow := uint64(1)
		for n := 0; n <= f.MaxItems; n++ {
			if n >= f.MinItems {
				total += pow
			}
			pow *= e
		}
		return total
	default:
		panic(fmt.Sprintf("dataeng: unknown kind %d", f.Kind))
	}
}

// Accept reports whether the schema accepts rec and, when it does not, the
// rejection reason. Unknown keys are always rejected.
func Accept(s *Schema, rec Record) (bool, error) {
	c, err := compile(s)
	if err != nil {
		return false, err
	}
	return c.accept(rec)
}

func (c *compiledSchema) accept(rec Record) (bool, error) {
	for name := range rec {
		if _, ok := c.index[name]; !ok {
			return false, fmt.Errorf("unknown field %q is forbidden", name)
		}
	}
	for i, f := range c.fields {
		v, present := rec[f.Name]
		if !present {
			if f.Required {
				return false, fmt.Errorf("required field %q is missing", f.Name)
			}
			continue
		}
		if err := c.checkValue(i, f, v); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (c *compiledSchema) checkValue(i int, f FieldSpec, v Value) error {
	switch f.Kind {
	case IntegerEnum:
		if v.kind == valueNull {
			if !f.Nullable {
				return fmt.Errorf("field %q: null is not allowed", f.Name)
			}
			return nil
		}
		if v.kind == valueArray {
			return fmt.Errorf("field %q: expected integer enum, got array", f.Name)
		}
		if v.kind != valueInt {
			return fmt.Errorf("field %q: invalid value", f.Name)
		}
		if _, ok := c.ranks[i][v.int]; !ok {
			return fmt.Errorf("field %q: value %d is not in enum %v", f.Name, v.int, f.Enum)
		}
		return nil
	case EnumArray:
		if v.kind == valueNull {
			return fmt.Errorf("field %q: null array is not allowed", f.Name)
		}
		if v.kind != valueArray {
			return fmt.Errorf("field %q: expected enum array, got integer", f.Name)
		}
		if len(v.arr) < f.MinItems {
			return fmt.Errorf("field %q: array length %d below MinItems %d", f.Name, len(v.arr), f.MinItems)
		}
		if len(v.arr) > f.MaxItems {
			return fmt.Errorf("field %q: array length %d exceeds MaxItems %d", f.Name, len(v.arr), f.MaxItems)
		}
		for _, element := range v.arr {
			if _, ok := c.ranks[i][element]; !ok {
				return fmt.Errorf("field %q: array element %d is not in enum %v", f.Name, element, f.Enum)
			}
		}
		return nil
	default:
		panic(fmt.Sprintf("dataeng: unknown kind %d", f.Kind))
	}
}
