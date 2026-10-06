export function data(partition, eventTime) {
    return { kind: "data", partition, eventTime };
}
export function idle(partition) {
    return { kind: "idle", partition };
}
export function active(partition) {
    return { kind: "active", partition };
}
//# sourceMappingURL=events.js.map