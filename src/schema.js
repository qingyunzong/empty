// Static schema: node types with their properties, and allowed edge types.
export const LOT_PATTERN = /^[A-Z][A-Z0-9]*-\d{4}-\d{4}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const defaultSchema = {
  nodeTypes: {
    raw_material: { description: 'incoming ingredient lot' },
    intermediate: { description: 'semi-finished batch' },
    product: { description: 'finished product batch' },
  },
  edgeTypes: {
    feeds_into: {
      from: ['raw_material', 'intermediate'],
      to: ['intermediate', 'product'],
    },
  },
  propTypes: {
    name: 'string',
    date: 'date',
    quantity: 'number',
    supplier: 'string',
  },
};

export function validateProps(schema, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    const kind = schema.propTypes[key];
    if (!kind) return `unknown property '${key}'`;
    if (kind === 'string' && typeof value !== 'string') return `property '${key}' must be a string`;
    if (kind === 'number' && typeof value !== 'number') return `property '${key}' must be a number`;
    if (kind === 'date' && (typeof value !== 'string' || !DATE_PATTERN.test(value))) {
      return `property '${key}' must be a YYYY-MM-DD date`;
    }
  }
  return null;
}
