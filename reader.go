package q194

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

const xmlNamespace = "http://www.w3.org/XML/1998/namespace"
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/"

type nsChange struct {
	prefix string
	old    string
	oldSet bool
}

type fieldCapture struct {
	name  Name
	value strings.Builder
}

type elementFrame struct {
	rawSpace string
	rawLocal string
	name     Name
	parent   *elementFrame
	field    *fieldCapture
	record   bool
	ns       []nsChange
}

// Reader converts a byte stream into record events.
//
// Next returns one event at a time. Fields are ordered as follows: requested
// attributes first (in configuration order, omitting absent attributes), then
// direct child text as each matching child closes, in document order.
//
// A syntax or input error that happens after a record has started is reported
// as an EventAbort for that record. The abort event is returned with a nil
// error so that event-oriented callers cannot miss it; the next call to Next
// returns the underlying error. Once a record has committed it cannot later be
// aborted.
type Reader struct {
	dec *xml.Decoder
	cfg normalizedConfig

	childText map[Name]struct{}
	stack     []*elementFrame
	ns        map[string]string
	active    *elementFrame

	pending []Event
	fatal   error
}

// NewReader creates a streaming record reader. It does not read from src until
// Next is called.
func NewReader(src io.Reader, cfg Config) (*Reader, error) {
	if src == nil {
		return nil, ErrInvalidSource
	}
	normalized, err := normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}

	dec := xml.NewDecoder(newEntityReader(src))
	dec.Strict = true

	childText := make(map[Name]struct{}, len(normalized.childText))
	for _, name := range normalized.childText {
		childText[name] = struct{}{}
	}

	return &Reader{
		dec:       dec,
		cfg:       normalized,
		childText: childText,
		ns:        map[string]string{"xml": xmlNamespace},
	}, nil
}

// Next returns the next event. At a normal end of input it returns io.EOF.
//
// If the stream fails after a record has started, Next first returns an
// EventAbort carrying that failure and a nil error. The following call returns
// the failure. The failure is sticky: later calls return it again.
func (r *Reader) Next() (Event, error) {
	if len(r.pending) > 0 {
		event := r.pending[0]
		r.pending = r.pending[1:]
		return event, nil
	}
	if r.fatal != nil {
		return Event{}, r.fatal
	}

	for {
		token, err := r.dec.RawToken()
		if err != nil {
			return r.fail(err)
		}

		switch token := token.(type) {
		case xml.StartElement:
			if err := r.startElement(token); err != nil {
				return r.fail(err)
			}
		case xml.EndElement:
			if err := r.endElement(token); err != nil {
				return r.fail(err)
			}
		case xml.CharData:
			r.charData(token)
		case xml.Directive:
			line, column := r.dec.InputPos()
			return r.fail(fmt.Errorf("%w (line %d, column %d)", ErrDTD, line, column))
		case xml.Comment, xml.ProcInst:
		}

		if len(r.pending) > 0 {
			event := r.pending[0]
			r.pending = r.pending[1:]
			return event, nil
		}
	}
}

func (r *Reader) startElement(start xml.StartElement) error {
	frame, attrs, err := r.prepareFrame(start)
	if err != nil {
		return err
	}

	parent := (*elementFrame)(nil)
	if len(r.stack) > 0 {
		parent = r.stack[len(r.stack)-1]
	}
	frame.parent = parent
	r.stack = append(r.stack, frame)

	if r.active == nil && frame.name == r.cfg.record {
		r.active = frame
		frame.record = true
		r.pending = append(r.pending, Event{
			Kind:       EventStart,
			Record:     frame.name,
			Attributes: attrs,
		})
		for _, name := range r.cfg.attributes {
			if value, ok := attrs[name]; ok {
				r.pending = append(r.pending, Event{
					Kind:   EventField,
					Record: frame.name,
					Field:  name,
					Value:  value,
					Source: FieldAttribute,
				})
			}
		}
		return nil
	}

	if r.active != nil && parent == r.active {
		if _, ok := r.childText[frame.name]; ok {
			frame.field = &fieldCapture{name: frame.name}
		}
	}
	return nil
}

func (r *Reader) endElement(end xml.EndElement) error {
	if len(r.stack) == 0 {
		return r.xmlError("unexpected end element </%s>", end.Name.Local)
	}
	frame := r.stack[len(r.stack)-1]

	if frame.rawSpace != end.Name.Space || frame.rawLocal != end.Name.Local {
		if frame.rawSpace == "" {
			return r.xmlError("element <%s> closed by </%s>", frame.name, end.Name.Local)
		}
		return r.xmlError(
			"element <%s:%s> closed by </%s:%s>",
			frame.rawSpace, frame.rawLocal, end.Name.Space, end.Name.Local,
		)
	}
	if _, err := r.resolveName(end.Name, false); err != nil {
		return err
	}

	if frame.field != nil {
		r.pending = append(r.pending, Event{
			Kind:   EventField,
			Record: r.activeName(),
			Field:  frame.field.name,
			Value:  frame.field.value.String(),
			Source: FieldText,
		})
	}
	if frame.record {
		r.pending = append(r.pending, Event{
			Kind:   EventCommit,
			Record: frame.name,
		})
		r.active = nil
	}

	r.stack = r.stack[:len(r.stack)-1]
	r.popNamespace(frame.ns)
	return nil
}

func (r *Reader) charData(data xml.CharData) {
	if r.active == nil || len(r.stack) == 0 {
		return
	}
	top := r.stack[len(r.stack)-1]
	if top.field != nil && top.parent == r.active {
		top.field.value.Write(data)
	}
}

func (r *Reader) prepareFrame(start xml.StartElement) (*elementFrame, map[Name]string, error) {
	frame := &elementFrame{
		rawSpace: start.Name.Space,
		rawLocal: start.Name.Local,
	}

	decls, err := r.bindNamespaces(start.Attr)
	if err != nil {
		return nil, nil, err
	}
	frame.ns = decls

	name, err := r.resolveName(start.Name, true)
	if err != nil {
		r.popNamespace(decls)
		return nil, nil, err
	}
	frame.name = name

	attrs := make(map[Name]string, len(start.Attr))
	seen := make(map[Name]struct{}, len(start.Attr))
	for _, attr := range start.Attr {
		if isNamespaceDeclaration(attr) {
			continue
		}
		name, err := r.resolveName(attr.Name, false)
		if err != nil {
			r.popNamespace(decls)
			return nil, nil, err
		}
		if _, ok := seen[name]; ok {
			r.popNamespace(decls)
			return nil, nil, r.xmlError("duplicate attribute %s", name)
		}
		seen[name] = struct{}{}
		attrs[name] = attr.Value
	}

	selected := make(map[Name]string, len(r.cfg.attributes))
	for _, name := range r.cfg.attributes {
		if value, ok := attrs[name]; ok {
			selected[name] = value
		}
	}
	return frame, selected, nil
}

func (r *Reader) bindNamespaces(attrs []xml.Attr) ([]nsChange, error) {
	var changes []nsChange
	declared := make(map[string]struct{})

	for _, attr := range attrs {
		prefix, ok := namespaceDeclarationPrefix(attr)
		if !ok {
			continue
		}
		if _, duplicate := declared[prefix]; duplicate {
			r.popNamespace(changes)
			return nil, r.xmlError("duplicate namespace declaration for %q", prefix)
		}
		declared[prefix] = struct{}{}

		if prefix == "xmlns" {
			r.popNamespace(changes)
			return nil, r.xmlError("the xmlns prefix cannot be declared")
		}
		if prefix == "xml" && attr.Value != xmlNamespace {
			r.popNamespace(changes)
			return nil, r.xmlError("the xml prefix must be bound to %s", xmlNamespace)
		}
		if prefix != "xml" && attr.Value == xmlNamespace {
			r.popNamespace(changes)
			return nil, r.xmlError("the XML namespace may only be bound to the xml prefix")
		}
		if prefix != "" && attr.Value == "" {
			r.popNamespace(changes)
			return nil, r.xmlError("namespace prefix %q cannot be bound to an empty URI", prefix)
		}
		if attr.Value == xmlnsNamespace {
			r.popNamespace(changes)
			return nil, r.xmlError("the xmlns namespace cannot be declared")
		}

		old, oldSet := r.ns[prefix]
		if attr.Value == "" {
			delete(r.ns, prefix)
		} else {
			r.ns[prefix] = attr.Value
		}
		changes = append(changes, nsChange{
			prefix: prefix,
			old:    old,
			oldSet: oldSet,
		})
	}
	return changes, nil
}

func (r *Reader) resolveName(raw xml.Name, isElement bool) (Name, error) {
	if raw.Space == "xmlns" {
		if isElement {
			return Name{}, r.xmlError("the xmlns prefix cannot be used for an element")
		}
		return Name{}, nil
	}
	if raw.Space == "" {
		if isElement {
			return Name{Space: r.ns[""], Local: raw.Local}, nil
		}
		return Name{Local: raw.Local}, nil
	}
	if raw.Space == "xml" {
		return Name{Space: xmlNamespace, Local: raw.Local}, nil
	}
	if space, ok := r.ns[raw.Space]; ok {
		return Name{Space: space, Local: raw.Local}, nil
	}
	return Name{}, r.xmlError("undeclared namespace prefix %q", raw.Space)
}

func (r *Reader) popNamespace(changes []nsChange) {
	for i := len(changes) - 1; i >= 0; i-- {
		change := changes[i]
		if change.oldSet {
			r.ns[change.prefix] = change.old
		} else {
			delete(r.ns, change.prefix)
		}
	}
}

func (r *Reader) activeName() Name {
	if r.active == nil {
		return Name{}
	}
	return r.active.name
}

func (r *Reader) fail(err error) (Event, error) {
	if r.fatal != nil {
		return Event{}, r.fatal
	}

	if err == io.EOF {
		switch {
		case r.active != nil:
			err = r.xmlError("unexpected end of input in record %s", r.active.name)
		case len(r.stack) > 0:
			err = r.xmlError("unexpected end of input inside element %s", r.stack[len(r.stack)-1].name)
		default:
			r.fatal = io.EOF
			return Event{}, io.EOF
		}
	}
	r.fatal = err

	if r.active != nil {
		record := r.active.name
		r.active = nil
		return Event{
			Kind:   EventAbort,
			Record: record,
			Err:    err,
		}, nil
	}
	return Event{}, err
}

func (r *Reader) xmlError(format string, args ...any) error {
	line, column := r.dec.InputPos()
	return fmt.Errorf("q194: XML error at line %d, column %d: %s", line, column, fmt.Sprintf(format, args...))
}

func isNamespaceDeclaration(attr xml.Attr) bool {
	return (attr.Name.Space == "" && attr.Name.Local == "xmlns") ||
		attr.Name.Space == "xmlns"
}

func namespaceDeclarationPrefix(attr xml.Attr) (string, bool) {
	switch {
	case attr.Name.Space == "" && attr.Name.Local == "xmlns":
		return "", true
	case attr.Name.Space == "xmlns":
		return attr.Name.Local, true
	default:
		return "", false
	}
}

// Consume reads all events from r and calls handle for each one. It returns
// nil at normal EOF. If a record aborts, the abort event is still delivered
// before the error is returned.
func (r *Reader) Consume(handle Handler) error {
	return consumeReader(r, handle)
}

// Consume is the convenience form of NewReader followed by Reader.Consume.
func Consume(src io.Reader, cfg Config, handle Handler) error {
	r, err := NewReader(src, cfg)
	if err != nil {
		return err
	}
	return r.Consume(handle)
}

// ConsumeContext is Consume with cancellation support. If ctx is cancelled
// while a record is open, the handler receives an EventAbort with ctx.Err()
// before ConsumeContext returns.
func ConsumeContext(ctx context.Context, src io.Reader, cfg Config, handle Handler) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if src == nil {
		return ErrInvalidSource
	}
	r, err := NewReader(contextReader{ctx: ctx, src: src}, cfg)
	if err != nil {
		return err
	}
	if handle == nil {
		return ErrNilHandler
	}

	var open bool
	var record Name
	for {
		if err := ctx.Err(); err != nil {
			if open {
				_ = handle(Event{Kind: EventAbort, Record: record, Err: err})
			}
			return err
		}

		event, nextErr := r.Next()
		if event.Kind != 0 {
			switch event.Kind {
			case EventStart:
				open = true
				record = event.Record
			case EventCommit, EventAbort:
				open = false
			}
			if handlerErr := handle(event); handlerErr != nil {
				if open {
					_ = handle(Event{Kind: EventAbort, Record: record, Err: handlerErr})
				}
				return handlerErr
			}
		}
		if nextErr == io.EOF {
			return nil
		}
		if nextErr != nil {
			return nextErr
		}
	}
}

type contextReader struct {
	ctx context.Context
	src io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.src.Read(p)
}
