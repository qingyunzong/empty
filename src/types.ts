export interface ResourceIdentifier {
  type: string;
  id: string;
}

export interface JsonApiRelationship {
  data?: ResourceIdentifier | ResourceIdentifier[] | null;
  links?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface JsonApiResource {
  type: string;
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, JsonApiRelationship>;
  links?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface JsonApiDocument {
  data?: JsonApiResource | JsonApiResource[] | null;
  included?: JsonApiResource[];
  links?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** Pointer back to the exact location a field value came from. */
export interface SourcePointer {
  /** Index of the document in the merge input array. */
  documentIndex: number;
  /** Source generation; higher generations win attribute conflicts. */
  generation: number;
  /** JSON-pointer-ish path of the resource inside its source document. */
  pointer: string;
}

/** Sparse fieldsets: resource type -> allowed field names. */
export type SparseFieldsets = Record<string, readonly string[]>;
