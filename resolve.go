package dataeng

import (
	"errors"
	"fmt"
)

// Promotion describes a permitted writer-to-reader type promotion.
type Promotion uint8

const (
	NoPromotion Promotion = iota
	IntToLong
	IntToFloat
	IntToDouble
	LongToFloat
	LongToDouble
	FloatToDouble
	StringToBytes
	BytesToString
)

// String returns a human-readable promotion name.
func (p Promotion) String() string {
	switch p {
	case NoPromotion:
		return "none"
	case IntToLong:
		return "int->long"
	case IntToFloat:
		return "int->float"
	case IntToDouble:
		return "int->double"
	case LongToFloat:
		return "long->float"
	case LongToDouble:
		return "long->double"
	case FloatToDouble:
		return "float->double"
	case StringToBytes:
		return "string->bytes"
	case BytesToString:
		return "bytes->string"
	default:
		return "unknown"
	}
}

// FieldResolution describes how one reader record field is produced.
type FieldResolution struct {
	// Writer is nil when the field is absent from the writer schema.
	Writer *Field
	Reader *Field

	// Resolution is nil when UseDefault is true.
	Resolution *Resolution
	UseDefault bool
	// Default is the reader-schema default, already normalised to the
	// canonical Go representation used by this package.
	Default any
}

// UnionResolution describes resolution at a writer and/or reader union.
type UnionResolution struct {
	WriterIsUnion bool
	ReaderIsUnion bool

	// Branches is indexed by writer branch when WriterIsUnion is true.
	// ReaderIndices contains the selected reader branch index for each
	// writer branch (-1 when the reader is not a union).
	Branches      []*Resolution
	ReaderIndices []int

	// Single is used when the writer is not a union and the reader is.
	Single      *Resolution
	ReaderIndex int
}

// Resolution is a compiled writer-to-reader schema resolution graph. It is
// immutable after construction and safe for concurrent use.
type Resolution struct {
	Writer *Schema
	Reader *Schema

	Promotion Promotion

	// Fields is in reader field order.
	Fields []FieldResolution
	Array  *Resolution
	Map    *Resolution
	Union  *UnionResolution
}

// Resolver resolves generic Go data from a writer schema to a reader schema.
type Resolver struct {
	writer *Schema
	reader *Schema
	plan   *Resolution
}

// NewResolver compiles a writer/reader schema pair according to Avro schema
// resolution rules. The returned resolver is immutable and safe for
// concurrent use.
func NewResolver(writer, reader *Schema) (*Resolver, error) {
	if writer == nil {
		return nil, errors.New("avro: nil writer schema")
	}
	if reader == nil {
		return nil, errors.New("avro: nil reader schema")
	}
	b := &builder{
		nodes: make(map[pair]*Resolution),
	}
	plan, err := b.build(writer, reader)
	if err != nil {
		return nil, fmt.Errorf("avro: cannot resolve schemas: %w", err)
	}
	return &Resolver{writer: writer, reader: reader, plan: plan}, nil
}

// WriterSchema returns the writer schema.
func (r *Resolver) WriterSchema() *Schema { return r.writer }

// ReaderSchema returns the reader schema.
func (r *Resolver) ReaderSchema() *Schema { return r.reader }

// Plan returns the compiled resolution graph.
func (r *Resolver) Plan() *Resolution { return r.plan }

// Resolve applies the compiled resolution to a writer datum.
func (r *Resolver) Resolve(datum any) (any, error) {
	if r == nil || r.plan == nil {
		return nil, errors.New("avro: nil resolver")
	}
	return resolveValue(r.plan, datum)
}

// Resolve compiles writer/reader once and resolves one datum.
func Resolve(writer, reader *Schema, datum any) (any, error) {
	resolver, err := NewResolver(writer, reader)
	if err != nil {
		return nil, err
	}
	return resolver.Resolve(datum)
}

// Compatible reports whether a writer schema can be read with a reader
// schema under the Avro compatibility rules.
func Compatible(writer, reader *Schema) bool {
	if writer == nil || reader == nil {
		return false
	}
	c := &compatChecker{state: make(map[pair]compatState)}
	return c.check(writer, reader)
}

type pair struct {
	writer *Schema
	reader *Schema
}

type builder struct {
	nodes map[pair]*Resolution
}

func (b *builder) build(writer, reader *Schema) (*Resolution, error) {
	if writer == nil || reader == nil {
		return nil, errors.New("nil schema")
	}
	key := pair{writer: writer, reader: reader}
	if existing := b.nodes[key]; existing != nil {
		return existing, nil
	}

	res := &Resolution{Writer: writer, Reader: reader}
	b.nodes[key] = res
	if err := b.fill(res); err != nil {
		delete(b.nodes, key)
		return nil, err
	}
	return res, nil
}

func (b *builder) fill(res *Resolution) error {
	writer, reader := res.Writer, res.Reader

	if writer.Type == Union || reader.Type == Union {
		return b.fillUnion(res)
	}

	if writer.Type != reader.Type {
		promotion, ok := promotionBetween(writer.Type, reader.Type)
		if !ok {
			return fmt.Errorf("writer type %s cannot be read as %s", writer.Type, reader.Type)
		}
		res.Promotion = promotion
		return nil
	}

	switch writer.Type {
	case Null, Boolean, Int, Long, Float, Double, Bytes, String:
		return nil
	case Record:
		if !namedMatch(writer, reader) {
			return fmt.Errorf("record name %q does not match reader name %q or its aliases", writer.FullName, reader.FullName)
		}
		for _, readerField := range reader.Fields {
			writerField := matchWriterField(writer, readerField)
			if writerField == nil {
				if !readerField.HasDefault {
					return fmt.Errorf("reader field %q has no writer field and no default", readerField.Name)
				}
				def, err := defaultValue(readerField.Type, readerField.Default)
				if err != nil {
					return fmt.Errorf("reader field %q default: %w", readerField.Name, err)
				}
				res.Fields = append(res.Fields, FieldResolution{
					Reader:     readerField,
					UseDefault: true,
					Default:    def,
				})
				continue
			}
			fieldRes, err := b.build(writerField.Type, readerField.Type)
			if err != nil {
				return fmt.Errorf("field %q: %w", readerField.Name, err)
			}
			res.Fields = append(res.Fields, FieldResolution{
				Writer:     writerField,
				Reader:     readerField,
				Resolution: fieldRes,
			})
		}
		return nil
	case Enum:
		if !namedMatch(writer, reader) {
			return fmt.Errorf("enum name %q does not match reader name %q or its aliases", writer.FullName, reader.FullName)
		}
		for _, symbol := range writer.Symbols {
			if !containsString(reader.Symbols, symbol) && !reader.HasEnumDefault {
				return fmt.Errorf("reader enum %q has no symbol %q and no default", reader.FullName, symbol)
			}
		}
		return nil
	case Fixed:
		if !namedMatch(writer, reader) {
			return fmt.Errorf("fixed name %q does not match reader name %q or its aliases", writer.FullName, reader.FullName)
		}
		if writer.Size != reader.Size {
			return fmt.Errorf("fixed size %d does not match reader size %d", writer.Size, reader.Size)
		}
		return nil
	case Array:
		items, err := b.build(writer.Items, reader.Items)
		if err != nil {
			return fmt.Errorf("array items: %w", err)
		}
		res.Array = items
		return nil
	case Map:
		values, err := b.build(writer.Values, reader.Values)
		if err != nil {
			return fmt.Errorf("map values: %w", err)
		}
		res.Map = values
		return nil
	default:
		return fmt.Errorf("unsupported schema type %q", writer.Type)
	}
}

func (b *builder) fillUnion(res *Resolution) error {
	writer, reader := res.Writer, res.Reader
	u := &UnionResolution{
		WriterIsUnion: writer.Type == Union,
		ReaderIsUnion: reader.Type == Union,
	}

	if writer.Type == Union {
		for i, writerBranch := range writer.Branches {
			if reader.Type == Union {
				readerIndex := b.firstCompatibleBranch(writerBranch, reader.Branches)
				if readerIndex < 0 {
					return fmt.Errorf("writer union branch %d (%s) has no matching reader branch", i, writerBranch)
				}
				branchRes, err := b.build(writerBranch, reader.Branches[readerIndex])
				if err != nil {
					return fmt.Errorf("writer union branch %d: %w", i, err)
				}
				u.Branches = append(u.Branches, branchRes)
				u.ReaderIndices = append(u.ReaderIndices, readerIndex)
				continue
			}
			branchRes, err := b.build(writerBranch, reader)
			if err != nil {
				return fmt.Errorf("writer union branch %d: %w", i, err)
			}
			u.Branches = append(u.Branches, branchRes)
			u.ReaderIndices = append(u.ReaderIndices, -1)
		}
		res.Union = u
		return nil
	}

	readerIndex := b.firstCompatibleBranch(writer, reader.Branches)
	if readerIndex < 0 {
		return fmt.Errorf("writer type %s has no matching reader union branch", writer)
	}
	single, err := b.build(writer, reader.Branches[readerIndex])
	if err != nil {
		return fmt.Errorf("reader union branch %d: %w", readerIndex, err)
	}
	u.Single = single
	u.ReaderIndex = readerIndex
	res.Union = u
	return nil
}

func (b *builder) firstCompatibleBranch(writer *Schema, readers []*Schema) int {
	for i, reader := range readers {
		// A fresh checker per candidate prevents a coinductive assumption
		// made while probing one branch from leaking into the next.
		checker := &compatChecker{state: make(map[pair]compatState)}
		if checker.check(writer, reader) {
			return i
		}
	}
	return -1
}

func promotionBetween(writer, reader Kind) (Promotion, bool) {
	switch {
	case writer == Int && reader == Long:
		return IntToLong, true
	case writer == Int && reader == Float:
		return IntToFloat, true
	case writer == Int && reader == Double:
		return IntToDouble, true
	case writer == Long && reader == Float:
		return LongToFloat, true
	case writer == Long && reader == Double:
		return LongToDouble, true
	case writer == Float && reader == Double:
		return FloatToDouble, true
	case writer == String && reader == Bytes:
		return StringToBytes, true
	case writer == Bytes && reader == String:
		return BytesToString, true
	default:
		return NoPromotion, false
	}
}

func namedMatch(writer, reader *Schema) bool {
	if writer.FullName == reader.FullName {
		return true
	}
	return containsString(reader.Aliases, writer.FullName)
}

func matchWriterField(writer *Schema, readerField *Field) *Field {
	for _, writerField := range writer.Fields {
		if writerField.Name == readerField.Name {
			return writerField
		}
	}
	for _, alias := range readerField.Aliases {
		for _, writerField := range writer.Fields {
			if writerField.Name == alias {
				return writerField
			}
		}
	}
	return nil
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

type compatState uint8

const (
	compatUnknown compatState = iota
	compatVisiting
	compatYes
	compatNo
)

// compatChecker uses coinductive memoisation: meeting a pair that is already
// being checked is assumed compatible. Recursive named schemas therefore
// terminate without expanding the reference graph indefinitely.
type compatChecker struct {
	state map[pair]compatState
}

func (c *compatChecker) check(writer, reader *Schema) bool {
	if writer == nil || reader == nil {
		return false
	}
	key := pair{writer: writer, reader: reader}
	switch c.state[key] {
	case compatVisiting, compatYes:
		return true
	case compatNo:
		return false
	}
	c.state[key] = compatVisiting
	ok := c.checkRules(writer, reader)
	if ok {
		c.state[key] = compatYes
	} else {
		c.state[key] = compatNo
	}
	return ok
}

func (c *compatChecker) checkRules(writer, reader *Schema) bool {
	if writer.Type == Union || reader.Type == Union {
		switch {
		case writer.Type == Union && reader.Type == Union:
			for _, writerBranch := range writer.Branches {
				matched := false
				for _, readerBranch := range reader.Branches {
					if c.check(writerBranch, readerBranch) {
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
				if !c.check(writerBranch, reader) {
					return false
				}
			}
			return true
		default:
			for _, readerBranch := range reader.Branches {
				if c.check(writer, readerBranch) {
					return true
				}
			}
			return false
		}
	}

	if writer.Type != reader.Type {
		_, ok := promotionBetween(writer.Type, reader.Type)
		return ok
	}

	switch writer.Type {
	case Null, Boolean, Int, Long, Float, Double, Bytes, String:
		return true
	case Record:
		if !namedMatch(writer, reader) {
			return false
		}
		for _, readerField := range reader.Fields {
			writerField := matchWriterField(writer, readerField)
			if writerField == nil {
				if !readerField.HasDefault {
					return false
				}
				continue
			}
			if !c.check(writerField.Type, readerField.Type) {
				return false
			}
		}
		return true
	case Enum:
		if !namedMatch(writer, reader) {
			return false
		}
		for _, symbol := range writer.Symbols {
			if !containsString(reader.Symbols, symbol) && !reader.HasEnumDefault {
				return false
			}
		}
		return true
	case Fixed:
		return namedMatch(writer, reader) && writer.Size == reader.Size
	case Array:
		return c.check(writer.Items, reader.Items)
	case Map:
		return c.check(writer.Values, reader.Values)
	default:
		return false
	}
}
