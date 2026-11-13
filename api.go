package dataeng

import "errors"

var errNilHandler = errors.New("avro: nil handler")

// Parse is an alias for ParseSchema.
func Parse(data []byte) (*Schema, error) { return ParseSchema(data) }

// ParseString is an alias for ParseSchemaString.
func ParseString(s string) (*Schema, error) { return ParseSchemaString(s) }

// CheckCompatibility returns an error when writer data cannot be read with
// reader under Avro resolution rules.
func CheckCompatibility(writer, reader *Schema) error {
	_, err := NewResolver(writer, reader)
	return err
}

// SchemaCompatible is an alias for Compatible.
func SchemaCompatible(writer, reader *Schema) bool { return Compatible(writer, reader) }

// NewResolverFromJSON parses both schemas and compiles a resolver.
func NewResolverFromJSON(writerJSON, readerJSON []byte) (*Resolver, error) {
	writer, err := ParseSchema(writerJSON)
	if err != nil {
		return nil, err
	}
	reader, err := ParseSchema(readerJSON)
	if err != nil {
		return nil, err
	}
	return NewResolver(writer, reader)
}

// Handler is a pre-compiled message entry adapter. It is safe for concurrent
// use.
type Handler struct {
	resolver *Resolver
}

// NewHandler compiles writer/reader schemas for repeated message resolution.
func NewHandler(writer, reader *Schema) (*Handler, error) {
	resolver, err := NewResolver(writer, reader)
	if err != nil {
		return nil, err
	}
	return &Handler{resolver: resolver}, nil
}

// NewHandlerFromJSON parses writer/reader schemas and returns a handler.
func NewHandlerFromJSON(writerJSON, readerJSON []byte) (*Handler, error) {
	resolver, err := NewResolverFromJSON(writerJSON, readerJSON)
	if err != nil {
		return nil, err
	}
	return &Handler{resolver: resolver}, nil
}

// Resolve converts one already-decoded writer datum.
func (h *Handler) Resolve(datum any) (any, error) {
	if h == nil || h.resolver == nil {
		return nil, errNilHandler
	}
	return h.resolver.Resolve(datum)
}

// ResolveJSON decodes and converts one JSON message.
func (h *Handler) ResolveJSON(message []byte) (any, error) {
	if h == nil || h.resolver == nil {
		return nil, errNilHandler
	}
	return h.resolver.ResolveJSON(message)
}

// Resolver returns the underlying resolver.
func (h *Handler) Resolver() *Resolver {
	if h == nil {
		return nil
	}
	return h.resolver
}
