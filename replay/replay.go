// Package replay re-exports the stream replay API under a package name that
// reads naturally at call sites. The implementation lives in the module root
// package.
package replay

import "example.org/dataeng/q0186"

type Message = dataeng.Message

type Column = dataeng.Column
type ColumnDefinition = dataeng.ColumnDefinition
type SchemaColumn = dataeng.SchemaColumn
type Schema = dataeng.Schema
type SchemaMessage = dataeng.SchemaMessage

type Dictionary = dataeng.Dictionary
type DictionaryMessage = dataeng.DictionaryMessage
type DictionaryUpdate = dataeng.DictionaryUpdate

type ColumnBatch = dataeng.ColumnBatch
type Batch = dataeng.Batch
type BatchMessage = dataeng.BatchMessage
type RecordBatch = dataeng.RecordBatch

type Result = dataeng.Result
type ResolvedColumn = dataeng.ResolvedColumn
type Stream = dataeng.Stream
type ReplayStream = dataeng.ReplayStream

type BatchError = dataeng.BatchError
type BatchErrors = dataeng.BatchErrors
type MissingGenerationError = dataeng.MissingGenerationError
type GenerationConflictError = dataeng.GenerationConflictError
type DictionaryIndexError = dataeng.DictionaryIndexError

const (
	TypeInt        = dataeng.TypeInt
	TypeInt64      = dataeng.TypeInt64
	TypeFloat64    = dataeng.TypeFloat64
	TypeString     = dataeng.TypeString
	TypeBool       = dataeng.TypeBool
	TypeBytes      = dataeng.TypeBytes
	TypeDictionary = dataeng.TypeDictionary

	Replace           = dataeng.Replace
	Append            = dataeng.Append
	DictionaryReplace = dataeng.DictionaryReplace
	DictionaryAppend  = dataeng.DictionaryAppend
)

var (
	ErrSchemaRequired     = dataeng.ErrSchemaRequired
	ErrSchemaAlreadySet   = dataeng.ErrSchemaAlreadySet
	ErrClosed             = dataeng.ErrClosed
	ErrInvalidMessage     = dataeng.ErrInvalidMessage
	ErrUnknownColumn      = dataeng.ErrUnknownColumn
	ErrUnknownDictionary  = dataeng.ErrUnknownDictionary
	ErrInvalidGeneration  = dataeng.ErrInvalidGeneration
	ErrInvalidIndex       = dataeng.ErrInvalidIndex
	ErrGenerationConflict = dataeng.ErrGenerationConflict
	ErrMissingGeneration  = dataeng.ErrMissingGeneration
	ErrPendingBatch       = dataeng.ErrPendingBatch
)

func NewStream() *Stream { return dataeng.NewStream() }
func New() *Stream       { return dataeng.New() }
func NewReplay() *Stream { return dataeng.NewReplay() }

func NewSchema(columns ...Column) SchemaMessage { return dataeng.NewSchema(columns...) }
func NewDictionary(id string, generation int, mode string, values ...any) DictionaryMessage {
	return dataeng.NewDictionary(id, generation, mode, values...)
}
func NewBatch(generations map[string]int, columns ...ColumnBatch) BatchMessage {
	return dataeng.NewBatch(generations, columns...)
}
func NewColumnBatch(name string, indices []int) ColumnBatch {
	return dataeng.NewColumnBatch(name, indices)
}

func DecodeMessage(data []byte) (Message, error) { return dataeng.DecodeMessage(data) }
func ParseMessage(data []byte) (Message, error)  { return dataeng.ParseMessage(data) }

func Replay(messages ...Message) ([]Result, error) { return dataeng.Replay(messages...) }
func ReplayMessages(messages ...Message) ([]Result, error) {
	return dataeng.ReplayMessages(messages...)
}
func Process(messages ...Message) ([]Result, error) { return dataeng.Process(messages...) }
