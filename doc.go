// Package dataeng provides batch ingestion helpers that isolate failed
// records without losing their source coordinates.
//
// A batch is processed record by record. Successful records are returned in
// delivery order, while failed records are converted into dead letters that
// retain the original partition, offset, and payload. One failed record never
// rolls back the rest of the batch.
package dataeng
