package dataeng

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

func normalizeMessage(message any) (any, error) {
	switch m := message.(type) {
	case SchemaMessage:
		return m, nil
	case *SchemaMessage:
		if m == nil {
			return nil, fmt.Errorf("%w: nil schema", ErrInvalidMessage)
		}
		return *m, nil
	case DictionaryMessage:
		return m, nil
	case *DictionaryMessage:
		if m == nil {
			return nil, fmt.Errorf("%w: nil dictionary", ErrInvalidMessage)
		}
		return *m, nil
	case BatchMessage:
		return m, nil
	case *BatchMessage:
		if m == nil {
			return nil, fmt.Errorf("%w: nil batch", ErrInvalidMessage)
		}
		return *m, nil
	case []byte:
		return DecodeMessage(m)
	case json.RawMessage:
		return DecodeMessage(m)
	case string:
		return DecodeMessage([]byte(m))
	case map[string]any:
		return messageFromMap(m)
	case map[string]string:
		converted := make(map[string]any, len(m))
		for key, value := range m {
			converted[key] = value
		}
		return messageFromMap(converted)
	default:
		return nil, fmt.Errorf("%w: unsupported %T", ErrInvalidMessage, message)
	}
}

func mergeGenerations(sources ...any) (map[string]int, error) {
	merged := make(map[string]int)
	for _, source := range sources {
		if source == nil {
			continue
		}
		values, err := asGenerationMap(source)
		if err != nil {
			return nil, err
		}
		for id, generation := range values {
			if existing, ok := merged[id]; ok && existing != generation {
				return nil, fmt.Errorf("%w: dictionary %q declares generations %d and %d", ErrInvalidMessage, id, existing, generation)
			}
			merged[id] = generation
		}
	}
	return merged, nil
}

func asGenerationMap(v any) (map[string]int, error) {
	if values, ok := v.(map[string]int); ok {
		copy := make(map[string]int, len(values))
		for key, value := range values {
			copy[key] = value
		}
		return copy, nil
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Map || rv.Type().Key().Kind() != reflect.String {
		return nil, fmt.Errorf("%w: generations must be a map from dictionary ID to generation, got %T", ErrInvalidMessage, v)
	}
	result := make(map[string]int, rv.Len())
	iter := rv.MapRange()
	for iter.Next() {
		key := iter.Key().String()
		generation, err := toInt(iter.Value().Interface())
		if err != nil {
			return nil, fmt.Errorf("%w: generation for %q: %v", ErrInvalidMessage, key, err)
		}
		result[key] = generation
	}
	return result, nil
}

func normalizeBatchColumns(m *BatchMessage, schemaColumns []Column, columnByID map[string]Column) ([]ColumnBatch, error) {
	var columns []ColumnBatch
	var err error
	source := firstNonNil(m.Columns, m.ColumnBatches, m.ColumnData, m.Data)
	if source == nil && m.Rows != nil {
		columns, err = columnsFromRows(m.Rows, schemaColumns, columnByID)
	} else if source != nil {
		columns, err = asColumnBatches(source, columnByID, schemaColumns)
	}
	if err != nil {
		return nil, err
	}

	if m.Indices != nil {
		columns, err = mergeColumnMap(columns, m.Indices, true, columnByID, schemaColumns)
		if err != nil {
			return nil, err
		}
	}
	if m.Values != nil {
		columns, err = mergeColumnMap(columns, m.Values, false, columnByID, schemaColumns)
		if err != nil {
			return nil, err
		}
	}
	for i := range columns {
		column := &columns[i]
		if column.name() == "" {
			return nil, fmt.Errorf("%w: batch column has no name", ErrInvalidMessage)
		}
		// Take ownership of the vectors now. A queued batch then cannot be
		// changed by a caller mutating the slices it passed to Feed.
		if raw := column.rawIndices(); raw != nil {
			indices, ok := asIndices(raw)
			if !ok {
				return nil, fmt.Errorf("%w: column %q indices must be integers", ErrInvalidMessage, column.name())
			}
			column.Indices = indices
			column.Index = nil
		}
		if raw := column.rawValues(); raw != nil {
			values, ok := asValues(raw)
			if !ok {
				return nil, fmt.Errorf("%w: column %q values must be a slice", ErrInvalidMessage, column.name())
			}
			column.Values = cloneValues(values)
			column.Entries = nil
		}
	}
	return columns, nil
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func asColumnBatches(v any, columnByID map[string]Column, schemaColumns []Column) ([]ColumnBatch, error) {
	switch typed := v.(type) {
	case []ColumnBatch:
		return append([]ColumnBatch(nil), typed...), nil
	case []*ColumnBatch:
		columns := make([]ColumnBatch, 0, len(typed))
		for _, column := range typed {
			if column == nil {
				return nil, fmt.Errorf("%w: nil column batch", ErrInvalidMessage)
			}
			columns = append(columns, *column)
		}
		return columns, nil
	case map[string]any:
		return columnsFromMap(typed, columnByID, schemaColumns)
	case map[string][]int:
		columns := columnsFromTypedMap(typed, true)
		sortColumnsBySchema(columns, schemaColumns)
		return columns, nil
	case map[string][]any:
		columns := columnsFromTypedValues(typed)
		sortColumnsBySchema(columns, schemaColumns)
		return columns, nil
	}

	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Map && rv.Type().Key().Kind() == reflect.String {
		return columnsFromReflectMap(rv, columnByID, schemaColumns)
	}
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, fmt.Errorf("%w: batch columns must be a slice or map, got %T", ErrInvalidMessage, v)
	}
	columns := make([]ColumnBatch, 0, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		element := rv.Index(i).Interface()
		switch column := element.(type) {
		case ColumnBatch:
			columns = append(columns, column)
		case *ColumnBatch:
			if column == nil {
				return nil, fmt.Errorf("%w: nil column batch", ErrInvalidMessage)
			}
			columns = append(columns, *column)
		case map[string]any:
			built, err := columnFromMap(column)
			if err != nil {
				return nil, err
			}
			columns = append(columns, built)
		default:
			return nil, fmt.Errorf("%w: unsupported column batch %T", ErrInvalidMessage, element)
		}
	}
	return columns, nil
}

func columnFromMap(m map[string]any) (ColumnBatch, error) {
	column := ColumnBatch{}
	if value, ok := m["name"]; ok {
		column.Name = fmt.Sprint(value)
	}
	if value, ok := m["column_name"]; ok {
		column.ColumnName = fmt.Sprint(value)
	}
	if value, ok := m["column"]; ok {
		column.Column = fmt.Sprint(value)
	}
	if value, ok := m["indices"]; ok {
		column.Indices = value
	}
	if value, ok := m["index"]; ok {
		column.Index = value
	}
	if value, ok := m["values"]; ok {
		column.Values = value
	}
	if value, ok := m["entries"]; ok {
		column.Entries = value
	}
	return column, nil
}

func columnsFromMap(m map[string]any, columnByID map[string]Column, schemaColumns []Column) ([]ColumnBatch, error) {
	keys := orderedColumnKeys(m, schemaColumns)
	columns := make([]ColumnBatch, 0, len(keys))
	for _, key := range keys {
		value := m[key]
		column := ColumnBatch{Name: key}
		if declared := columnByID[key]; declared.dictionaryID() != "" {
			// A map may carry raw indices or already-decoded dictionary values.
			// Only an all-integer vector is treated as indices.
			if values, ok := asValues(value); ok && allIntegers(values) {
				column.Indices = value
			}
		}
		column.Values = value
		columns = append(columns, column)
	}
	return columns, nil
}

func columnsFromTypedMap(m map[string][]int, indices bool) []ColumnBatch {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	columns := make([]ColumnBatch, 0, len(keys))
	for _, key := range keys {
		column := ColumnBatch{Name: key}
		if indices {
			column.Indices = m[key]
		} else {
			column.Values = m[key]
		}
		columns = append(columns, column)
	}
	return columns
}

func columnsFromTypedValues(m map[string][]any) []ColumnBatch {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	columns := make([]ColumnBatch, 0, len(keys))
	for _, key := range keys {
		columns = append(columns, ColumnBatch{Name: key, Values: m[key]})
	}
	return columns
}

func columnsFromReflectMap(rv reflect.Value, columnByID map[string]Column, schemaColumns []Column) ([]ColumnBatch, error) {
	raw := make(map[string]any, rv.Len())
	iter := rv.MapRange()
	for iter.Next() {
		raw[iter.Key().String()] = iter.Value().Interface()
	}
	return columnsFromMap(raw, columnByID, schemaColumns)
}

func orderedColumnKeys(m map[string]any, schemaColumns []Column) []string {
	keys := make([]string, 0, len(m))
	seen := make(map[string]struct{}, len(m))
	for _, column := range schemaColumns {
		name := column.name()
		if _, ok := m[name]; ok {
			keys = append(keys, name)
			seen[name] = struct{}{}
		}
	}
	var remaining []string
	for key := range m {
		if _, ok := seen[key]; !ok {
			remaining = append(remaining, key)
		}
	}
	sort.Strings(remaining)
	return append(keys, remaining...)
}

func mergeColumnMap(columns []ColumnBatch, v any, indices bool, columnByID map[string]Column, schemaColumns []Column) ([]ColumnBatch, error) {
	rv := reflect.ValueOf(v)
	var raw map[string]any
	switch typed := v.(type) {
	case map[string]any:
		raw = typed
	case map[string][]int:
		raw = make(map[string]any, len(typed))
		for key, value := range typed {
			raw[key] = value
		}
	case map[string][]any:
		raw = make(map[string]any, len(typed))
		for key, value := range typed {
			raw[key] = value
		}
	default:
		if rv.Kind() != reflect.Map || rv.Type().Key().Kind() != reflect.String {
			return nil, fmt.Errorf("%w: column map must have string keys, got %T", ErrInvalidMessage, v)
		}
		raw = make(map[string]any, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			raw[iter.Key().String()] = iter.Value().Interface()
		}
	}

	for key, value := range raw {
		found := false
		for i := range columns {
			if columns[i].name() != key {
				continue
			}
			found = true
			if indices {
				if columns[i].rawIndices() != nil {
					existing, ok := asIndices(columns[i].rawIndices())
					incoming, ok2 := asIndices(value)
					if !ok || !ok2 || len(existing) != len(incoming) {
						return nil, fmt.Errorf("%w: column %q has conflicting indices", ErrInvalidMessage, key)
					}
					for j := range existing {
						if existing[j] != incoming[j] {
							return nil, fmt.Errorf("%w: column %q has conflicting indices", ErrInvalidMessage, key)
						}
					}
				}
				columns[i].Indices = value
			} else {
				if columns[i].rawValues() != nil {
					existing, ok := asValues(columns[i].rawValues())
					incoming, ok2 := asValues(value)
					if !ok || !ok2 {
						return nil, fmt.Errorf("%w: column %q has conflicting values", ErrInvalidMessage, key)
					}
					if !valuesEqual(existing, incoming) {
						return nil, fmt.Errorf("%w: column %q has conflicting values", ErrInvalidMessage, key)
					}
				}
				columns[i].Values = value
				if declared := columnByID[key]; declared.dictionaryID() != "" {
					if values, ok := asValues(value); ok && allIntegers(values) && columns[i].rawIndices() == nil {
						columns[i].Indices = value
					}
				}
			}
			break
		}
		if found {
			continue
		}
		column := ColumnBatch{Name: key}
		if indices {
			column.Indices = value
		} else {
			column.Values = value
			if declared := columnByID[key]; declared.dictionaryID() != "" {
				if values, ok := asValues(value); ok && allIntegers(values) {
					column.Indices = value
				}
			}
		}
		columns = append(columns, column)
	}
	sortColumnsBySchema(columns, schemaColumns)
	return columns, nil
}

func sortColumnsBySchema(columns []ColumnBatch, schemaColumns []Column) {
	order := make(map[string]int, len(schemaColumns))
	for i, column := range schemaColumns {
		order[column.name()] = i
	}
	sort.SliceStable(columns, func(i, j int) bool {
		left, leftOK := order[columns[i].name()]
		right, rightOK := order[columns[j].name()]
		switch {
		case leftOK && rightOK:
			return left < right
		case leftOK:
			return true
		case rightOK:
			return false
		default:
			return columns[i].name() < columns[j].name()
		}
	})
}

func columnsFromRows(v any, schemaColumns []Column, columnByID map[string]Column) ([]ColumnBatch, error) {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, fmt.Errorf("%w: rows must be a slice, got %T", ErrInvalidMessage, v)
	}
	rows := make([][]any, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		row, ok := asValues(rv.Index(i).Interface())
		if !ok {
			return nil, fmt.Errorf("%w: row %d is not a slice", ErrInvalidMessage, i)
		}
		if len(row) != len(schemaColumns) {
			return nil, fmt.Errorf("%w: row %d has %d cells, schema has %d columns", ErrColumnLength, i, len(row), len(schemaColumns))
		}
		rows[i] = row
	}
	columns := make([]ColumnBatch, len(schemaColumns))
	for columnIndex, declared := range schemaColumns {
		name := declared.name()
		values := make([]any, len(rows))
		for rowIndex := range rows {
			values[rowIndex] = rows[rowIndex][columnIndex]
		}
		column := ColumnBatch{Name: name, Values: values}
		if declared.dictionaryID() != "" && allIntegers(values) {
			indices := make([]int, len(values))
			for i, value := range values {
				index, err := toInt(value)
				if err != nil {
					return nil, err
				}
				indices[i] = index
			}
			column.Indices = indices
		}
		columns[columnIndex] = column
	}
	return columns, nil
}

func allIntegers(values []any) bool {
	for _, value := range values {
		if _, err := toInt(value); err != nil {
			return false
		}
	}
	return true
}

func messageFromMap(m map[string]any) (any, error) {
	kind := strings.ToLower(fmt.Sprint(firstNonNil(m["type"], m["kind"], m["message_type"])))
	switch kind {
	case "schema":
		return schemaFromMap(m)
	case "dictionary", "dict":
		return dictionaryFromMap(m)
	case "batch", "record_batch", "recordbatch":
		return batchFromMap(m)
	default:
		// Fall back to a shape-based decision to make simple JSON hand-written
		// fixtures easier to use.
		switch {
		case m["columns"] != nil && m["generation"] == nil:
			if _, ok := m["values"]; ok {
				return batchFromMap(m)
			}
			return schemaFromMap(m)
		case m["generation"] != nil || m["values"] != nil:
			return dictionaryFromMap(m)
		default:
			return nil, fmt.Errorf("%w: cannot determine message type", ErrInvalidMessage)
		}
	}
}

func schemaFromMap(m map[string]any) (SchemaMessage, error) {
	raw := firstNonNil(m["columns"], m["column_defs"], m["definitions"])
	columns, err := asSchemaColumns(raw)
	if err != nil {
		return SchemaMessage{}, err
	}
	return SchemaMessage{Columns: columns}, nil
}

func asSchemaColumns(v any) ([]Column, error) {
	if v == nil {
		return nil, fmt.Errorf("%w: schema has no columns", ErrInvalidMessage)
	}
	if columns, ok := v.([]Column); ok {
		return columns, nil
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, fmt.Errorf("%w: schema columns must be a slice", ErrInvalidMessage)
	}
	columns := make([]Column, 0, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		element := rv.Index(i).Interface()
		switch column := element.(type) {
		case Column:
			columns = append(columns, column)
		case map[string]any:
			built := Column{}
			built.Name = fmt.Sprint(firstNonNil(column["name"], column["column_name"], column["column"]))
			built.Type = fmt.Sprint(firstNonNil(column["type"], column["kind"], column["column_type"]))
			built.DictionaryID = fmt.Sprint(firstNonNil(column["dictionary_id"], column["dict_id"], column["dictionary"]))
			columns = append(columns, built)
		default:
			return nil, fmt.Errorf("%w: unsupported schema column %T", ErrInvalidMessage, element)
		}
	}
	return columns, nil
}

func dictionaryFromMap(m map[string]any) (DictionaryMessage, error) {
	message := DictionaryMessage{}
	message.ID = fmt.Sprint(firstNonNil(m["id"], m["dictionary_id"], m["dict_id"]))
	if value := firstNonNil(m["generation"], m["gen"]); value != nil {
		generation, err := toInt(value)
		if err != nil {
			return DictionaryMessage{}, fmt.Errorf("%w: generation: %v", ErrInvalidMessage, err)
		}
		message.Generation = generation
	}
	message.Mode = fmt.Sprint(firstNonNil(m["mode"], m["operation"]))
	if value, ok := m["replace"]; ok {
		message.Replace = fmt.Sprint(value) == "true"
	}
	if value, ok := m["append"]; ok {
		message.Append = fmt.Sprint(value) == "true"
	}
	message.Values = firstNonNil(m["values"], m["entries"], m["items"])
	return message, nil
}

func batchFromMap(m map[string]any) (BatchMessage, error) {
	message := BatchMessage{}
	message.Generations = firstNonNil(m["generations"], m["required_generations"], m["dictionary_generations"], m["required"], m["dictionaries"])
	message.Columns = firstNonNil(m["columns"], m["column_batches"], m["column_data"], m["data"])
	message.Rows = m["rows"]
	message.Indices = m["indices"]
	message.Values = m["values"]
	return message, nil
}

// DecodeMessage parses a JSON object with a "type" or "kind" field. It is
// exported so hosts can feed wire messages directly into a Stream.
func DecodeMessage(data []byte) (Message, error) {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	var raw any
	if err := decoder.Decode(&raw); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidMessage, err)
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: JSON message must be an object", ErrInvalidMessage)
	}
	return messageFromMap(m)
}

// ParseMessage is an alias for DecodeMessage.
func ParseMessage(data []byte) (Message, error) { return DecodeMessage(data) }
