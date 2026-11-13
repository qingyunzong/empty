package dataeng

import "strings"

// Kind identifies the type of an HTML event delivered to an Extractor.
type Kind int

const (
	// KindText is a run of character data.
	KindText Kind = iota
	// KindStartTag is an opening tag such as <div>.
	KindStartTag
	// KindEndTag is a closing tag such as </div>.
	KindEndTag
	// KindComment is an HTML comment.
	KindComment
)

// Range is a half-open byte range [Start, End) into the source document.
type Range struct {
	Start, End int
}

// Event is a single tokenized HTML event. The extractor never parses bytes
// on its own; it only consumes events supplied by the caller.
type Event struct {
	Kind Kind
	// Name is the tag name for KindStartTag and KindEndTag events.
	Name string
	// Data is the payload for KindText and KindComment events.
	Data string
	// Span is the event's source range.
	Span Range
	// SelfClosing marks tags written as <tag/>.
	SelfClosing bool
	// Partial marks an event cut off in the middle of a tag; feeding it
	// returns StatusPending and leaves the extractor state untouched.
	Partial bool
}

// Status is the result of feeding one event.
type Status int

const (
	// StatusOK means the event was consumed.
	StatusOK Status = iota
	// StatusPending means the event was cut off mid-tag and no state changed.
	StatusPending
)

// rawTextTags switch the extractor into raw text state, where '<' does not
// open a tag and text is not visible.
var rawTextTags = map[string]bool{
	"script":   true,
	"style":    true,
	"textarea": true,
}

// blockTags append a newline to the visible output when they end.
var blockTags = map[string]bool{
	"address": true, "article": true, "aside": true, "blockquote": true,
	"br": true, "dd": true, "details": true, "div": true, "dl": true,
	"dt": true, "fieldset": true, "figcaption": true, "figure": true,
	"footer": true, "form": true, "h1": true, "h2": true, "h3": true,
	"h4": true, "h5": true, "h6": true, "header": true, "hgroup": true,
	"hr": true, "li": true, "main": true, "nav": true, "ol": true,
	"p": true, "pre": true, "section": true, "table": true, "tbody": true,
	"td": true, "tfoot": true, "th": true, "thead": true, "tr": true,
	"ul": true,
}

// voidTags have no end tag; their start tag also ends them.
var voidTags = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true,
	"hr": true, "img": true, "input": true, "link": true, "meta": true,
	"source": true, "track": true, "wbr": true,
}

// Extractor pulls visible text out of a stream of HTML events.
type Extractor struct {
	out    strings.Builder
	rawTag string // raw text tag currently open, "" if none
	tail   byte   // last byte written to out
	hidden []Range
}

// NewExtractor returns a ready-to-use Extractor.
func NewExtractor() *Extractor { return &Extractor{} }

// Feed consumes one event. A Partial event returns StatusPending without
// changing any state, so the caller can re-feed it once complete.
func (e *Extractor) Feed(ev Event) Status {
	if ev.Partial {
		return StatusPending
	}
	switch ev.Kind {
	case KindText:
		e.text(ev.Span, ev.Data)
	case KindComment:
		// Comments are never visible. Inside raw text they are not
		// comments at all, only more raw text.
		if e.rawTag != "" {
			e.hidden = append(e.hidden, ev.Span)
		}
	case KindStartTag:
		e.startTag(ev)
	case KindEndTag:
		e.endTag(ev)
	}
	return StatusOK
}

// Text returns the visible text extracted so far.
func (e *Extractor) Text() string { return e.out.String() }

// Hidden returns the source ranges of text swallowed by raw text elements
// (script, style, textarea), in the order the events arrived.
func (e *Extractor) Hidden() []Range {
	return append([]Range(nil), e.hidden...)
}

func (e *Extractor) text(span Range, data string) {
	if e.rawTag != "" {
		e.hidden = append(e.hidden, span)
		return
	}
	e.out.WriteString(data)
	if n := len(data); n > 0 {
		e.tail = data[n-1]
	}
}

func (e *Extractor) startTag(ev Event) {
	name := strings.ToLower(ev.Name)
	if e.rawTag != "" {
		// Inside raw text, '<' does not open a tag.
		e.hidden = append(e.hidden, ev.Span)
		return
	}
	if rawTextTags[name] && !ev.SelfClosing {
		e.rawTag = name
		return
	}
	if (ev.SelfClosing || voidTags[name]) && blockTags[name] {
		e.newline()
	}
}

func (e *Extractor) endTag(ev Event) {
	name := strings.ToLower(ev.Name)
	if e.rawTag != "" {
		if name == e.rawTag {
			e.rawTag = ""
		} else {
			e.hidden = append(e.hidden, ev.Span)
		}
		return
	}
	if blockTags[name] {
		e.newline()
	}
}

// newline appends a single '\n', merging runs of consecutive newlines and
// never emitting a leading newline.
func (e *Extractor) newline() {
	if e.out.Len() == 0 || e.tail == '\n' {
		return
	}
	e.out.WriteByte('\n')
	e.tail = '\n'
}
