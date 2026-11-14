// Package dataeng joins recognized PDF table fragments across consecutive
// pages.
//
// The input is a sequence of Page values containing recognized cells, page
// lines, and running header/footer regions. Assemble removes page furniture,
// reconstructs columns from borders and cell geometry, and joins the last
// fragment of one page to the first fragment of the next only when column
// geometry, the table-header signature, and page-break evidence agree.
//
// Repeated table headers are dropped from the assembled body, but every
// occurrence, including the removed one, remains available through
// Table.HeaderOccurrences with its source page, fragment, rows, and cells.
// Merged cells keep their RowSpan and ColSpan. A row clipped by a page break
// remains a separate Row fragment; the library never uses cell or row text
// similarity to reconstruct it. Ambiguous page transitions produce separate
// tables rather than a speculative join.
package dataeng
