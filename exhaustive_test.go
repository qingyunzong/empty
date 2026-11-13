package dataeng

import "testing"

// This file checks the primitive/union compatibility matrix against a small
// independent oracle. It intentionally uses only the resolution rules and no
// parser, so a parser bug cannot hide a resolver bug.

func TestExhaustivePrimitiveAndUnionMatrix(t *testing.T) {
	kinds := []Kind{Null, Boolean, Int, Long, Float, Double, Bytes, String}

	unions := make([][]Kind, 0, len(kinds)*(len(kinds)-1))
	for _, first := range kinds {
		for _, second := range kinds {
			if first == second {
				continue
			}
			unions = append(unions, []Kind{first, second})
		}
	}

	check := func(label string, want bool, writer, reader *Schema) {
		t.Helper()
		if got := oracleCompatible(writer, reader); got != want {
			t.Fatalf("test oracle disagrees at %s", label)
		}
		if got := Compatible(writer, reader); got != want {
			t.Errorf("Compatible(%s) = %v, want %v", label, got, want)
		}
		_, err := NewResolver(writer, reader)
		if gotOK := err == nil; gotOK != want {
			t.Errorf("NewResolver(%s) error = %v, want ok=%v", label, err, want)
		}
	}

	for _, writerKind := range kinds {
		for _, readerKind := range kinds {
			writer := kindSchema(writerKind)
			reader := kindSchema(readerKind)
			check(string(writerKind)+"->"+string(readerKind),
				oraclePrimitive(writerKind, readerKind), writer, reader)
		}
	}

	for _, writerKinds := range unions {
		writer := unionSchema(writerKinds...)
		for _, readerKind := range kinds {
			reader := kindSchema(readerKind)
			want := true
			for _, branch := range writerKinds {
				if !oraclePrimitive(branch, readerKind) {
					want = false
					break
				}
			}
			check("union"+kindList(writerKinds)+"->"+string(readerKind), want, writer, reader)
		}

		for _, readerKinds := range unions {
			reader := unionSchema(readerKinds...)
			want := true
			for _, writerBranch := range writerKinds {
				matched := false
				for _, readerBranch := range readerKinds {
					if oraclePrimitive(writerBranch, readerBranch) {
						matched = true
						break
					}
				}
				if !matched {
					want = false
					break
				}
			}
			check("union"+kindList(writerKinds)+"->union"+kindList(readerKinds), want, writer, reader)
		}
	}

	for _, writerKind := range kinds {
		writer := kindSchema(writerKind)
		for _, readerKinds := range unions {
			reader := unionSchema(readerKinds...)
			want := false
			for _, readerBranch := range readerKinds {
				if oraclePrimitive(writerKind, readerBranch) {
					want = true
					break
				}
			}
			check(string(writerKind)+"->union"+kindList(readerKinds), want, writer, reader)
		}
	}
}

func TestCompatibilityAndCompilationAgreeOnSmallSchemas(t *testing.T) {
	schemas := []*Schema{
		kindSchema(Null),
		kindSchema(Boolean),
		kindSchema(Int),
		kindSchema(Long),
		kindSchema(Float),
		kindSchema(Double),
		kindSchema(Bytes),
		kindSchema(String),
		unionSchema(Null, Int),
		unionSchema(Int, String),
		unionSchema(Long, Bytes),
		{Type: Array, Items: kindSchema(Int)},
		{Type: Array, Items: kindSchema(Long)},
		{Type: Map, Values: kindSchema(String)},
		{Type: Map, Values: kindSchema(Bytes)},
		recordSchema("R", fieldSpec{"a", kindSchema(Int), false}),
		recordSchema("R", fieldSpec{"a", kindSchema(Long), false}),
		recordSchema("R", fieldSpec{"a", kindSchema(Int), false}, fieldSpec{"b", kindSchema(String), true}),
		recordSchema("R", fieldSpec{"a", kindSchema(Int), false}, fieldSpec{"c", kindSchema(Boolean), false}),
		recordSchema("Alias", fieldSpec{"a", kindSchema(Int), false}),
		recordSchema("R", fieldSpec{"a", unionSchema(Null, String), true}),
		recordSchema("R", fieldSpec{"a", unionSchema(String, Null), true}),
	}
	aliasReader := recordSchema("R", fieldSpec{"a", kindSchema(Int), false})
	aliasReader.Aliases = []string{"Alias"}
	schemas = append(schemas, aliasReader)

	for i, writer := range schemas {
		for j, reader := range schemas {
			want := Compatible(writer, reader)
			_, err := NewResolver(writer, reader)
			if got := err == nil; got != want {
				t.Errorf("schemas[%d]->schemas[%d]: Compatible=%v, NewResolver err=%v", i, j, want, err)
			}
		}
	}
}

type fieldSpec struct {
	name       string
	schema     *Schema
	hasDefault bool
}

func recordSchema(name string, fields ...fieldSpec) *Schema {
	schema := &Schema{Type: Record, Name: name, FullName: name}
	for _, spec := range fields {
		field := &Field{Name: spec.name, Type: spec.schema, HasDefault: spec.hasDefault}
		if spec.hasDefault {
			field.Default = zeroDefault(spec.schema)
		}
		schema.Fields = append(schema.Fields, field)
	}
	return schema
}

func zeroDefault(schema *Schema) any {
	switch schema.Type {
	case Null:
		return nil
	case Boolean:
		return false
	case Int:
		return int32(0)
	case Long:
		return int64(0)
	case Float:
		return float32(0)
	case Double:
		return float64(0)
	case String, Bytes:
		return ""
	case Union:
		return zeroDefault(schema.Branches[0])
	default:
		return nil
	}
}

func kindSchema(kind Kind) *Schema { return &Schema{Type: kind} }

func unionSchema(kinds ...Kind) *Schema {
	schema := &Schema{Type: Union}
	for _, kind := range kinds {
		schema.Branches = append(schema.Branches, kindSchema(kind))
	}
	return schema
}

func kindList(kinds []Kind) string {
	out := "["
	for i, kind := range kinds {
		if i > 0 {
			out += ","
		}
		out += string(kind)
	}
	return out + "]"
}

func oracleCompatible(writer, reader *Schema) bool {
	switch {
	case writer.Type == Union && reader.Type == Union:
		for _, writerBranch := range writer.Branches {
			matched := false
			for _, readerBranch := range reader.Branches {
				if oracleCompatible(writerBranch, readerBranch) {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
		}
		return true
	case writer.Type == Union:
		for _, writerBranch := range writer.Branches {
			if !oracleCompatible(writerBranch, reader) {
				return false
			}
		}
		return true
	case reader.Type == Union:
		for _, readerBranch := range reader.Branches {
			if oracleCompatible(writer, readerBranch) {
				return true
			}
		}
		return false
	default:
		return oraclePrimitive(writer.Type, reader.Type)
	}
}

func oraclePrimitive(writer, reader Kind) bool {
	if writer == reader {
		return true
	}
	switch {
	case writer == Int && (reader == Long || reader == Float || reader == Double):
		return true
	case writer == Long && (reader == Float || reader == Double):
		return true
	case writer == Float && reader == Double:
		return true
	case writer == String && reader == Bytes:
		return true
	case writer == Bytes && reader == String:
		return true
	default:
		return false
	}
}
