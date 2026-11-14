package cri

import dataeng "example.org/dataeng/q0094"

type (
	Record             = dataeng.Record
	Entry              = dataeng.Entry
	LogRecord          = dataeng.LogRecord
	CRIRecord          = dataeng.CRIRecord
	CriRecord          = dataeng.CriRecord
	Fragment           = dataeng.Fragment
	Line               = dataeng.Line
	Input              = dataeng.Input
	PartialRecord      = dataeng.PartialRecord
	CRILine            = dataeng.CRILine
	Reassembler        = dataeng.Reassembler
	Assembler          = dataeng.Assembler
	Merger             = dataeng.Merger
	Combiner           = dataeng.Combiner
	PartialAssembler   = dataeng.PartialAssembler
	PartialReassembler = dataeng.PartialReassembler
	CRIReassembler     = dataeng.CRIReassembler
	LogReassembler     = dataeng.LogReassembler
	Config             = dataeng.Config
	ReassemblerOptions = dataeng.ReassemblerOptions
	Option             = dataeng.Option
	Options            = dataeng.Options
)

const (
	TagPartial              = dataeng.TagPartial
	TagFull                 = dataeng.TagFull
	P                       = dataeng.P
	F                       = dataeng.F
	Stdout                  = dataeng.Stdout
	Stderr                  = dataeng.Stderr
	StreamStdout            = dataeng.StreamStdout
	StreamStderr            = dataeng.StreamStderr
	TruncationMarker        = dataeng.TruncationMarker
	TruncatedMarker         = dataeng.TruncatedMarker
	DefaultTruncationMarker = dataeng.DefaultTruncationMarker
	TruncationMark          = dataeng.TruncationMark
)

var (
	ErrInvalidLine      = dataeng.ErrInvalidLine
	ErrInvalidTimestamp = dataeng.ErrInvalidTimestamp
)

func New(args ...any) *Reassembler            { return dataeng.New(args...) }
func NewReassembler(args ...any) *Reassembler { return dataeng.NewReassembler(args...) }
func NewAssembler(args ...any) *Reassembler   { return dataeng.NewAssembler(args...) }
func NewMerger(args ...any) *Reassembler      { return dataeng.NewMerger(args...) }
func NewCombiner(args ...any) *Reassembler    { return dataeng.NewCombiner(args...) }
func NewPartialReassembler(args ...any) *Reassembler {
	return dataeng.NewPartialReassembler(args...)
}
func NewCRIReassembler(args ...any) *Reassembler { return dataeng.NewCRIReassembler(args...) }
func NewLogReassembler(args ...any) *Reassembler { return dataeng.NewLogReassembler(args...) }
func WithMaxBytes(n int) Option                  { return dataeng.WithMaxBytes(n) }
func WithMaxSize(n int) Option                   { return dataeng.WithMaxSize(n) }
func WithMaxLength(n int) Option                 { return dataeng.WithMaxLength(n) }
func WithMaxFragments(n int) Option              { return dataeng.WithMaxFragments(n) }
func WithFragmentLimit(n int) Option             { return dataeng.WithFragmentLimit(n) }
func WithMaxParts(n int) Option                  { return dataeng.WithMaxParts(n) }
func WithLimit(n int) Option                     { return dataeng.WithLimit(n) }
func WithTruncationMarker(marker string) Option {
	return dataeng.WithTruncationMarker(marker)
}
func WithMarker(marker string) Option             { return dataeng.WithMarker(marker) }
func WithTruncatedMarker(marker string) Option    { return dataeng.WithTruncatedMarker(marker) }
func WithMaxRecordBytes(n int) Option             { return dataeng.WithMaxRecordBytes(n) }
func WithMaxRecordFragments(n int) Option         { return dataeng.WithMaxRecordFragments(n) }
func WithGeneration(generation any) Option        { return dataeng.WithGeneration(generation) }
func MaxBytes(n int) Option                       { return dataeng.MaxBytes(n) }
func MaxSize(n int) Option                        { return dataeng.MaxSize(n) }
func MaxLength(n int) Option                      { return dataeng.MaxLength(n) }
func MaxFragments(n int) Option                   { return dataeng.MaxFragments(n) }
func MaxParts(n int) Option                       { return dataeng.MaxParts(n) }
func Limit(n int) Option                          { return dataeng.Limit(n) }
func Marker(marker string) Option                 { return dataeng.Marker(marker) }
func Generation(generation any) Option            { return dataeng.Generation(generation) }
func ParseLine(line string) (Record, error)       { return dataeng.ParseLine(line) }
func ParseCRILine(line string) (Record, error)    { return dataeng.ParseCRILine(line) }
func ParseCRILog(line string) (Record, error)     { return dataeng.ParseCRILog(line) }
func ParseLogLine(line string) (Record, error)    { return dataeng.ParseLogLine(line) }
func ParseRecord(line string) (Record, error)     { return dataeng.ParseRecord(line) }
func Parse(line string) (Record, error)           { return dataeng.Parse(line) }
func ParseLines(lines []string) ([]Record, error) { return dataeng.ParseLines(lines) }
func Reassemble(args ...any) []Record             { return dataeng.Reassemble(args...) }
func Merge(args ...any) []Record                  { return dataeng.Merge(args...) }
func Combine(args ...any) []Record                { return dataeng.Combine(args...) }
func Assemble(args ...any) []Record               { return dataeng.Assemble(args...) }
func ProcessRecords(args ...any) []Record         { return dataeng.ProcessRecords(args...) }
func Process(args ...any) []Record                { return dataeng.Process(args...) }
func ProcessLine(line string) []Record            { return dataeng.ProcessLine(line) }
func ReassembleRecords(records []Record, args ...any) []Record {
	return dataeng.ReassembleRecords(records, args...)
}
func MergeRecords(records []Record, args ...any) []Record {
	return dataeng.MergeRecords(records, args...)
}
func CombineRecords(records []Record, args ...any) []Record {
	return dataeng.CombineRecords(records, args...)
}
func AssembleRecords(records []Record, args ...any) []Record {
	return dataeng.AssembleRecords(records, args...)
}
func ReassembleLines(lines []string, args ...any) []Record {
	return dataeng.ReassembleLines(lines, args...)
}
func MergeLines(lines []string, args ...any) []Record {
	return dataeng.MergeLines(lines, args...)
}
func ProcessLines(lines []string, args ...any) []Record {
	return dataeng.ProcessLines(lines, args...)
}
func RecordKey(record Record, generation any) string {
	return dataeng.RecordKey(record, generation)
}
