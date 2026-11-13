// Package dataeng implements Avro schema resolution for message entry points.
//
// A Resolver is compiled once from a writer and a reader schema and can then
// be used concurrently:
//
//	writer, _ := dataeng.ParseSchemaString(writerJSON)
//	reader, _ := dataeng.ParseSchemaString(readerJSON)
//	resolver, err := dataeng.NewResolver(writer, reader)
//	if err != nil { /* incompatible schemas */ }
//	message, err := resolver.ResolveJSON(payload)
//
// Resolution follows the Avro specification for records (including reader
// field aliases and reader-side defaults), enums, fixed, arrays, maps,
// unions, and numeric promotions. Writer union data must be tagged with a
// UnionValue because loose Go values (for example nil or int) cannot identify
// a union branch reliably. Reader union results are likewise returned as a
// UnionValue carrying the selected reader branch index.
//
// Defaults are interpreted strictly as the reader schema type. In particular,
// a union field default belongs to the first union branch; branches are never
// searched by name or by the shape of the default value.
//
// Named schemas are canonicalised during parsing. References point back to
// the same *Schema, and the resolver memoises (writer, reader) schema pairs,
// so recursive schemas are compiled as a finite reference graph rather than
// expanded into an infinite tree.
//
// Scalar data uses int32 for int, int64 for long, float32 for float, float64
// for double, string for string and enum, and []byte for bytes and fixed.
// Records use map[string]any, arrays []any, and maps map[string]any.
package dataeng
