package dataeng

import "fmt"

// ExpandView fully expands a list view into a nested model: every row is
// nil (null row) or []any; leaf values are nil (null) or int64. It is the
// reference model for verifying Compact.
func ExpandView(v *ListView) ([]any, error) {
	return expandView(v, 1)
}

func expandView(v *ListView, depth int) ([]any, error) {
	if v == nil {
		return nil, fmt.Errorf("dataeng: nil list view")
	}
	if depth > MaxDepth {
		return nil, fmt.Errorf("dataeng: nesting depth %d: %w", depth, ErrMaxDepth)
	}
	rows := len(v.Valid)
	if len(v.Starts) != rows || len(v.Lengths) != rows {
		return nil, fmt.Errorf("dataeng: row count mismatch: %d starts, %d lengths, %d valid bits",
			len(v.Starts), len(v.Lengths), rows)
	}
	var childLen int64
	switch c := v.Child.(type) {
	case *Int64Array:
		childLen = int64(len(c.Values))
	case *ListView:
		childLen = int64(len(c.Valid))
	default:
		return nil, fmt.Errorf("dataeng: unsupported child type %T", v.Child)
	}
	if _, _, err := validateRanges(v.Starts, v.Lengths, v.Valid, childLen); err != nil {
		return nil, err
	}

	out := make([]any, rows)
	switch c := v.Child.(type) {
	case *Int64Array:
		for i := 0; i < rows; i++ {
			if !v.Valid[i] {
				continue
			}
			row := make([]any, 0, v.Lengths[i])
			for j := v.Starts[i]; j < v.Starts[i]+v.Lengths[i]; j++ {
				if c.Valid[j] {
					row = append(row, c.Values[j])
				} else {
					row = append(row, nil)
				}
			}
			out[i] = row
		}
	case *ListView:
		sub := &ListView{Child: c.Child}
		for i := 0; i < rows; i++ {
			if !v.Valid[i] {
				continue
			}
			for j := v.Starts[i]; j < v.Starts[i]+v.Lengths[i]; j++ {
				sub.Starts = append(sub.Starts, c.Starts[j])
				sub.Lengths = append(sub.Lengths, c.Lengths[j])
				sub.Valid = append(sub.Valid, c.Valid[j])
			}
		}
		subRows, err := expandView(sub, depth+1)
		if err != nil {
			return nil, err
		}
		k := 0
		for i := 0; i < rows; i++ {
			if !v.Valid[i] {
				continue
			}
			row := make([]any, 0, v.Lengths[i])
			for j := int64(0); j < v.Lengths[i]; j++ {
				row = append(row, subRows[k])
				k++
			}
			out[i] = row
		}
	}
	return out, nil
}

// ExpandColumn fully expands a compacted list column into the same model
// shape as ExpandView.
func ExpandColumn(c *ListColumn) ([]any, error) {
	if c == nil {
		return nil, fmt.Errorf("dataeng: nil list column")
	}
	rows := len(c.Valid)
	if len(c.Offsets) != rows+1 {
		return nil, fmt.Errorf("dataeng: column has %d offsets for %d rows", len(c.Offsets), rows)
	}
	out := make([]any, rows)
	switch ch := c.Child.(type) {
	case *Int64Array:
		for i := 0; i < rows; i++ {
			if !c.Valid[i] {
				continue
			}
			row := make([]any, 0, c.Offsets[i+1]-c.Offsets[i])
			for k := c.Offsets[i]; k < c.Offsets[i+1]; k++ {
				if ch.Valid[k] {
					row = append(row, ch.Values[k])
				} else {
					row = append(row, nil)
				}
			}
			out[i] = row
		}
	case *ListColumn:
		subRows, err := ExpandColumn(ch)
		if err != nil {
			return nil, err
		}
		for i := 0; i < rows; i++ {
			if !c.Valid[i] {
				continue
			}
			row := make([]any, c.Offsets[i+1]-c.Offsets[i])
			copy(row, subRows[c.Offsets[i]:c.Offsets[i+1]])
			out[i] = row
		}
	default:
		return nil, fmt.Errorf("dataeng: unsupported child type %T", c.Child)
	}
	return out, nil
}
