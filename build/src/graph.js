export class Graph {
    edgesById = new Map();
    outgoingByNode = new Map();
    nodeSet = new Set();
    constructor(edges = []) {
        for (const edge of edges)
            this.addEdge(edge);
    }
    addEdge(edge) {
        if (this.edgesById.has(edge.id)) {
            throw new Error(`duplicate edge id: ${edge.id}`);
        }
        this.edgesById.set(edge.id, edge);
        this.nodeSet.add(edge.from);
        this.nodeSet.add(edge.to);
        let list = this.outgoingByNode.get(edge.from);
        if (list === undefined) {
            list = [];
            this.outgoingByNode.set(edge.from, list);
        }
        list.push(edge);
    }
    addNode(node) {
        this.nodeSet.add(node);
    }
    getEdge(id) {
        return this.edgesById.get(id);
    }
    outgoing(node) {
        return this.outgoingByNode.get(node) ?? [];
    }
    nodes() {
        return [...this.nodeSet];
    }
    edges() {
        return [...this.edgesById.values()];
    }
}
