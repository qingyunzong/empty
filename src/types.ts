export interface SourceMapData {
  version: 3;
  sources: string[];
  names: string[];
  mappings: string;
}

export interface Segment {
  genCol: number;
  src: number;
  srcLine: number;
  srcCol: number;
  name: number;
}

export interface ParsedSourceMap {
  sources: string[];
  names: string[];
  lines: Segment[][];
}

export interface OriginalPosition {
  source: string;
  line: number;
  column: number;
  name: string | undefined;
}
