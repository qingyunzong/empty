// Package dataeng provides an embeddable Avro schema parsing library for
// the event decoding service: it compiles registry schemas and their
// reference closure into named types (handling namespaces, aliases, union
// defaults and recursive records), caches compiled schemas by content
// fingerprint, and builds writer-reader resolution plans that report the
// first incompatible path.
package dataeng
