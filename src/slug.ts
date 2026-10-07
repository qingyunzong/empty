/**
 * Heading-id generation: ASCII lowercase + whitespace collapsing,
 * GitHub-style dedup with numeric suffixes.
 */

/** Strip inline markdown / HTML so the slug is derived from visible text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .trim();
}

/**
 * Lowercase ASCII, drop anything that is not [a-z0-9_-] or whitespace,
 * then collapse every whitespace run into a single "-".
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Assigns unique ids: first "foo", then "foo-1", "foo-2", ... */
export class Slugger {
  private readonly used = new Set<string>();

  slug(text: string): string {
    const base = slugify(text);
    if (!this.used.has(base)) {
      this.used.add(base);
      return base;
    }
    let n = 1;
    while (this.used.has(`${base}-${n}`)) n++;
    const id = `${base}-${n}`;
    this.used.add(id);
    return id;
  }
}
