/** A single sparse segment on a generated line. */
export interface Segment {
  /** 0-based generated line. */
  genLine: number;
  /** 0-based generated column. */
  genCol: number;
  /** Index into `sources`; absent means this segment is unmapped. */
  srcIndex?: number;
  /** 0-based source line (only when mapped). */
  srcLine?: number;
  /** 0-based source column (only when mapped). */
  srcCol?: number;
  /** Index into `names`; absent means no name on this segment. */
  nameIndex?: number;
}

/** Decoded source map: sparse segments sorted by (genLine, genCol). */
export interface SourceMapData {
  version: 3;
  sources: string[];
  names: string[];
  segments: Segment[];
}

/** Result of a position query. */
export interface Mapping {
  source: string;
  sourceIndex: number;
  line: number;
  column: number;
  name: string | undefined;
}
