package dataeng

// Aliases for callers that model CRI lines as entries or fragments.
type (
	Entry         = Record
	LogRecord     = Record
	CRIRecord     = Record
	CriRecord     = Record
	Fragment      = Record
	Line          = Record
	Input         = Record
	PartialRecord = Record

	Assembler = Reassembler
	Merger    = Reassembler
	Combiner  = Reassembler

	PartialAssembler   = Reassembler
	PartialReassembler = Reassembler
	CRIReassembler     = Reassembler
	LogReassembler     = Reassembler
)

// CRILine is a string-typed view of a CRI record. It is accepted anywhere a
// Record is accepted and is useful for callers that want to avoid the
// flexible timestamp fields in Record.
type CRILine struct {
	Timestamp  string
	Stream     string
	Tag        string
	Content    string
	Generation int64
}

// AsRecord converts a CRILine to a Record.
func (l CRILine) AsRecord() Record {
	return Record{
		Timestamp:  l.Timestamp,
		Stream:     l.Stream,
		Tag:        l.Tag,
		Content:    l.Content,
		Generation: l.Generation,
	}
}
