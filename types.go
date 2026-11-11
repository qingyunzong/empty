package q194

import (
	"errors"
	"fmt"
	"io"
	"strings"
)

// Name is an expanded XML name. Space is a namespace URI, not a prefix.
// An empty Space means that the name is in no namespace.
type Name struct {
	Space string
	Local string
}

// ExpandedName is an alias for Name.
type ExpandedName = Name

// String renders a name in Clark notation ("{namespace}local") when it is
// namespace-qualified, and as a plain local name otherwise.
func (n Name) String() string {
	if n.Space == "" {
		return n.Local
	}
	return "{" + n.Space + "}" + n.Local
}

// Config describes which parts of a record to extract.
//
// Record is the expanded name of the element that starts a record.
// Attributes lists attributes to extract from the record start tag.
// ChildText lists direct child elements whose directly contained character
// data should be extracted. Character data inside grandchildren is not
// included.
type Config struct {
	Record     Name
	Attributes []Name
	ChildText  []Name
}

// RecordConfig is an alias for Config.
type RecordConfig = Config

// EventKind identifies a record event.
type EventKind uint8

const (
	// EventStart begins a record.
	EventStart EventKind = iota + 1
	// EventField reports one extracted attribute or direct child text.
	EventField
	// EventCommit completes a record successfully.
	EventCommit
	// EventAbort revokes a record that has already started.
	EventAbort
)

func (k EventKind) String() string {
	switch k {
	case EventStart:
		return "start"
	case EventField:
		return "field"
	case EventCommit:
		return "commit"
	case EventAbort:
		return "abort"
	default:
		return fmt.Sprintf("EventKind(%d)", uint8(k))
	}
}

// FieldSource identifies where a field value came from.
type FieldSource uint8

const (
	// FieldAttribute means the value came from a record attribute.
	FieldAttribute FieldSource = iota + 1
	// FieldText means the value came from direct character data of a direct
	// child element.
	FieldText
)

func (s FieldSource) String() string {
	switch s {
	case FieldAttribute:
		return "attribute"
	case FieldText:
		return "text"
	default:
		return fmt.Sprintf("FieldSource(%d)", uint8(s))
	}
}

// Event is a record event.
//
// Start events carry Record and the requested attributes that were present.
// Field events carry Record, Field, Value, and Source. Commit and Abort
// events carry Record; Abort also carries Err.
type Event struct {
	Kind       EventKind
	Record     Name
	Field      Name
	Value      string
	Source     FieldSource
	Attributes map[Name]string
	Err        error
}

// ErrDTD is returned when the input contains a document type declaration or
// any other XML directive.
var ErrDTD = errors.New("q194: XML directives and DTDs are not supported")

// ErrInvalidConfig is returned when Config does not identify a usable record.
var ErrInvalidConfig = errors.New("q194: invalid record configuration")

// ErrInvalidSource is returned when a nil input reader is supplied.
var ErrInvalidSource = errors.New("q194: nil input reader")

// ErrNilHandler is returned when a nil event handler is supplied.
var ErrNilHandler = errors.New("q194: nil event handler")

// ErrUnsupportedEntity is returned for a named entity other than one of the
// five predefined XML entities.
var ErrUnsupportedEntity = errors.New("q194: unsupported XML entity")

// ErrInvalidCharacterReference is returned for a numeric character reference
// that does not denote a legal XML 1.0 character.
var ErrInvalidCharacterReference = errors.New("q194: invalid numeric character reference")

// Handler consumes one event. Returning an error stops consumption. If a
// record is open at that point, Consume and ConsumeContext deliver an Abort
// event for it before returning the handler's error.
type Handler func(Event) error

type normalizedConfig struct {
	record     Name
	attributes []Name
	childText  []Name
}

func normalizeConfig(cfg Config) (normalizedConfig, error) {
	if err := validateName("record", cfg.Record); err != nil {
		return normalizedConfig{}, err
	}

	attributes := make([]Name, len(cfg.Attributes))
	seen := make(map[Name]struct{}, len(cfg.Attributes))
	for i, name := range cfg.Attributes {
		if err := validateName("attribute", name); err != nil {
			return normalizedConfig{}, err
		}
		if _, ok := seen[name]; ok {
			return normalizedConfig{}, fmt.Errorf("%w: duplicate attribute %s", ErrInvalidConfig, name)
		}
		seen[name] = struct{}{}
		attributes[i] = name
	}

	childText := make([]Name, len(cfg.ChildText))
	seen = make(map[Name]struct{}, len(cfg.ChildText))
	for i, name := range cfg.ChildText {
		if err := validateName("child text", name); err != nil {
			return normalizedConfig{}, err
		}
		if _, ok := seen[name]; ok {
			return normalizedConfig{}, fmt.Errorf("%w: duplicate child text element %s", ErrInvalidConfig, name)
		}
		seen[name] = struct{}{}
		childText[i] = name
	}

	return normalizedConfig{
		record:     cfg.Record,
		attributes: attributes,
		childText:  childText,
	}, nil
}

func validateName(role string, name Name) error {
	if name.Local == "" {
		return fmt.Errorf("%w: %s local name is empty", ErrInvalidConfig, role)
	}
	if strings.ContainsAny(name.Local, "\t\r\n <>") {
		return fmt.Errorf("%w: invalid %s local name %q", ErrInvalidConfig, role, name.Local)
	}
	return nil
}

func consumeReader(r *Reader, handle Handler) error {
	if handle == nil {
		return ErrNilHandler
	}
	var open bool
	var record Name
	for {
		event, err := r.Next()
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
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
