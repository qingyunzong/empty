// Package formal implements a crash-safe WAL group-commit component.
//
// Concurrent transactions append commit records through GroupCommitter. The
// component serializes record placement, shares one fsync across each batch,
// and acknowledges a record only after its end LSN is covered by a successful
// sync. Recover returns exactly the complete, checksummed commit groups in the
// durable prefix.
package formal
