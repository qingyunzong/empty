package dataeng

// Message is one decoded syslog payload.
//
// A field represented by "-" in the wire format is stored as an empty string.
// StructuredData is nil when the wire format uses "-". Message is meaningful
// only when HasMessage is true; an empty Message with HasMessage set is a
// present, empty body.
type Message struct {
	PRI      int
	Facility int
	Severity int
	Version  byte

	Timestamp Timestamp

	Host    string
	AppName string
	ProcID  string
	MsgID   string

	StructuredData []SDElement

	Message    string
	HasMessage bool
	BOM        bool

	// Raw is the exact payload that produced this message. In particular,
	// escaping and a message BOM are still present in Raw.
	Raw []byte
}

// Timestamp is a parsed syslog timestamp. For a nil timestamp ("-"), Nil is
// true and only Raw is populated. Zone is one of "", "Z", or an offset such as
// "+00:00" or "-00:00"; no time-zone conversion is performed.
type Timestamp struct {
	Raw      string
	Nil      bool
	Year     int
	Month    int
	Day      int
	Hour     int
	Minute   int
	Second   int
	Fraction string
	Zone     string
}

// SDElement is one structured-data element.
type SDElement struct {
	ID     string
	Params []SDParam
}

// SDParam is one structured-data parameter. Parameters are kept in wire
// order, including duplicates.
type SDParam struct {
	Name  string
	Value string
}

// ParseMessage parses one complete payload. It rejects trailing bytes rather
// than treating them as another message or another frame.
func ParseMessage(payload []byte) (Message, error) {
	return parseMessage(payload)
}
