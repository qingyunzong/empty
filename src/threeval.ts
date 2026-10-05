export type Tri = 'T' | 'F' | 'U';

export const tri = {
  and(a: Tri, b: Tri): Tri {
    if (a === 'F' || b === 'F') return 'F';
    if (a === 'T' && b === 'T') return 'T';
    return 'U';
  },
  or(a: Tri, b: Tri): Tri {
    if (a === 'T' || b === 'T') return 'T';
    if (a === 'F' && b === 'F') return 'F';
    return 'U';
  },
  not(a: Tri): Tri {
    if (a === 'T') return 'F';
    if (a === 'F') return 'T';
    return 'U';
  },
  fromBool(value: boolean): Tri {
    return value ? 'T' : 'F';
  },
} as const;
