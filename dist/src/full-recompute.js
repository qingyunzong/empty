/**
 * 对照实现：全量重算。
 *
 * 不做任何依赖跟踪：computed 每次 get 都重新求值；任何 source 变化
 * 都会重新运行所有 effect。用于对照主库的按需（增量）重算。
 */
const listeners = new Set();
export function source(initial) {
    let value = initial;
    return {
        get: () => value,
        set(v) {
            if (Object.is(v, value))
                return;
            value = v;
            for (const l of [...listeners])
                l();
        },
    };
}
export function computed(fn) {
    return {
        get: () => fn(),
        dispose: () => { },
    };
}
export function effect(fn) {
    listeners.add(fn);
    fn();
    return {
        dispose: () => {
            listeners.delete(fn);
        },
    };
}
