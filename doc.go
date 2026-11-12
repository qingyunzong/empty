// Package dataeng incrementally decodes the closed S8 compressed data region
// used by historical survey files.
//
// The package does not parse a SAV/SPSS file dictionary, does not perform
// statistics, and does not claim full SAV compatibility. It consumes only the
// opcode/literal byte region and returns rows whose fields were declared by
// the host in advance.
//
// Push accepts arbitrary byte slices. Only complete, validated rows are
// returned; an incomplete row is held until more input arrives. A successful
// stream is reported only after an explicit opcode 252 and a successful
// Finish.
package dataeng
