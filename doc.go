// Package dataeng implements importable SNMP GetBulk table traversal.
//
// A walk accepts one or more table column base OIDs and produces rows aligned
// by instance index. Columns advance independently, so endOfMibView, a
// non-increasing OID, or an out-of-bounds reply retires only the affected
// column. Missing values remain visible as non-present cells carrying their
// source column identity.
package dataeng
