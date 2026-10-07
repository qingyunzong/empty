import { MAX_DOORS, MAX_GRID, MAX_KEYS, posKey, } from './types.js';
/**
 * Parses an ASCII grid. Characters:
 *   '#'  wall
 *   '.'  floor
 *   'S'  start (exactly one)
 *   'G'  goal (exactly one)
 *   'a'-'e'  keys (at most 5 distinct)
 *   'A'-'E'  doors, each opened by the matching lowercase key
 * Grid must be rectangular and at most 10x10.
 */
export function parseGrid(text) {
    const rows = text.replace(/\r/g, '').split('\n').filter((r) => r.length > 0);
    if (rows.length === 0)
        throw new Error('grid is empty');
    const height = rows.length;
    const width = rows[0].length;
    if (width > MAX_GRID || height > MAX_GRID) {
        throw new Error(`grid must be at most ${MAX_GRID}x${MAX_GRID}, got ${width}x${height}`);
    }
    const walls = new Array(width * height).fill(false);
    const keys = [];
    const doors = [];
    const keyAt = new Map();
    const doorAt = new Map();
    let start = null;
    let goal = null;
    const keyLetters = new Set();
    for (let y = 0; y < height; y++) {
        const row = rows[y];
        if (row.length !== width)
            throw new Error(`row ${y} has length ${row.length}, expected ${width}`);
        for (let x = 0; x < width; x++) {
            const ch = row[x];
            if (ch === '#') {
                walls[y * width + x] = true;
            }
            else if (ch === '.') {
                // floor
            }
            else if (ch === 'S') {
                if (start)
                    throw new Error('multiple start cells');
                start = { x, y };
            }
            else if (ch === 'G') {
                if (goal)
                    throw new Error('multiple goal cells');
                goal = { x, y };
            }
            else if (ch >= 'a' && ch <= 'z') {
                const keyIndex = ch.charCodeAt(0) - 97;
                if (keyIndex >= MAX_KEYS)
                    throw new Error(`key '${ch}' unsupported; at most ${MAX_KEYS} keys (a-e)`);
                if (keyAt.has(posKey(x, y)))
                    throw new Error(`duplicate key at ${x},${y}`);
                keyLetters.add(keyIndex);
                keyAt.set(posKey(x, y), keys.length);
                keys.push({ pos: { x, y }, keyIndex });
            }
            else if (ch >= 'A' && ch <= 'Z') {
                const keyIndex = ch.charCodeAt(0) - 65;
                if (keyIndex >= MAX_KEYS)
                    throw new Error(`door '${ch}' unsupported; at most ${MAX_KEYS} key types (A-E)`);
                doorAt.set(posKey(x, y), doors.length);
                doors.push({ pos: { x, y }, keyIndex });
            }
            else {
                throw new Error(`unexpected character '${ch}' at ${x},${y}`);
            }
        }
    }
    if (!start)
        throw new Error('grid has no start (S)');
    if (!goal)
        throw new Error('grid has no goal (G)');
    if (keyLetters.size > MAX_KEYS)
        throw new Error(`at most ${MAX_KEYS} distinct keys allowed`);
    if (doors.length > MAX_DOORS)
        throw new Error(`at most ${MAX_DOORS} door cells supported`);
    return { width, height, walls, start, goal, keys, doors, keyAt, doorAt };
}
export function initialState(grid) {
    return { x: grid.start.x, y: grid.start.y, keys: 0, openDoors: 0 };
}
