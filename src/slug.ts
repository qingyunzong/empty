/**
 * Heading ID ("slug") generation.
 *
 * Rules (per spec):
 *  - ASCII letters are lowercased; non-ASCII characters are left untouched.
 *  - Runs of whitespace collapse into a single `-`.
 *  - Leading/trailing whitespace is trimmed first, so it never produces
 *    leading/trailing hyphens.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/\s+/g, "-");
}

/**
 * Assigns unique IDs to headings in document order.
 * The first occurrence of a base slug is used as-is; repeats get a
 * numeric suffix: `foo`, `foo-1`, `foo-2`, ...
 */
export class Slugger {
  private readonly seen = new Map<string, number>();

  slug(text: string): string {
    const base = slugify(text);
    const count = this.seen.get(base) ?? 0;
    this.seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  }
}
