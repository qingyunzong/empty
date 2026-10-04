package cfg

// ResolveRecursive resolves every section with the per-field recursive
// model: each field is looked up through the inheritance chain at use
// time, and references inside the winning definition expand in the
// defining section's context (definition-site interpolation).
//
// It contrasts with Resolve (the flatten model), where inheritance is
// merged first and references expand in the requesting section's final
// fields (use-site interpolation).
func (c *Config) ResolveRecursive() (map[string]map[string]string, error) {
	if err := c.mergeFields(); err != nil {
		return nil, err
	}
	memo := map[Ref]string{}
	rec := map[Ref][]Ref{}
	sc := recursiveScope{c}
	out := map[string]map[string]string{}
	for _, name := range c.order {
		vals := map[string]string{}
		for _, field := range SortedFields(c.Sections[name].Fields) {
			v, err := c.expand(sc, Ref{Section: name, Field: field}, nil, memo, rec)
			if err != nil {
				return nil, err
			}
			vals[field] = v
		}
		out[name] = vals
	}
	return out, nil
}

// FieldDiff reports one field whose final value differs between the
// flatten model and the per-field recursive model.
type FieldDiff struct {
	Ref       Ref
	Flatten   string
	Recursive string
}

// CompareModels resolves the config with both models and returns the
// fields where they disagree. Plain (non-interpolated) fields always
// agree; only interpolated fields can diverge, because the two models
// pick different contexts for expanding inherited references.
func (c *Config) CompareModels() ([]FieldDiff, error) {
	if err := c.Resolve(); err != nil {
		return nil, err
	}
	rec, err := c.ResolveRecursive()
	if err != nil {
		return nil, err
	}
	var diffs []FieldDiff
	for _, name := range c.order {
		sec := c.Sections[name]
		for field, flat := range sec.Values {
			if r := rec[name][field]; r != flat {
				diffs = append(diffs, FieldDiff{Ref: Ref{Section: name, Field: field}, Flatten: flat, Recursive: r})
			}
		}
	}
	return diffs, nil
}
