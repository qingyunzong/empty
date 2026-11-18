// Package formal provides a size- and age-rotated log file writer.
//
// Rotation boundaries are explicit and closed on the triggering side. A file
// may contain exactly MaxSize bytes; the next non-empty write rotates first.
// A segment is eligible for time rotation at exactly MaxAge. Empty writes and
// empty segments never create backups.
//
// Retention keeps the active file plus the newest MaxBackups rotated files.
// Rotated files are gzipped on a best-effort basis: the raw file remains until
// the complete gzip replacement exists. MaxTotalBytes is a hard budget over
// the active and retained files; a write which cannot fit fails with
// ErrDiskFull instead of truncating or overwriting an existing log.
package formal
