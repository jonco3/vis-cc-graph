/*
 * Directed graph representation for heap graphs.
 */

import { assert } from './utils.js';

export class Graph {
  constructor () {
    this.nodes = [];
    this.internMap = new Map();
    this.addressToIdMap = new Map(); // todo: move to parser
  }

  // Add a node to the graph and return its id.
  // data: an object associated with this node. Retreived with getNode.
  addNode (data) {
    assert(typeof data === 'object');

    // todo: this can perhaps be stored separately later.
    data.id = this.nodes.length;
    data.incomingEdges = [];
    data.incomingEdgeNames = [];
    data.outgoingEdges = [];
    data.outgoingEdgeNames = [];

    this.nodes.push(data);
    return data.id;
  }

  // Get the data associated with a node.
  getNode (nodeId) {
    this.checkNodeId(nodeId);
    return this.nodes[nodeId];
  }

  nodeCount () {
    return this.nodes.length;
  }

  addEdge (sourceNode, targetNode, name) {
    sourceNode.outgoingEdges.push(targetNode.id);
    sourceNode.outgoingEdgeNames.push(name);
    targetNode.incomingEdges.push(sourceNode.id);
    targetNode.incomingEdgeNames.push(name);
  }

  // Utility method to canonicalise a value.
  intern (value) {
    const result = this.internMap.get(value);
    if (result !== undefined) {
      return result;
    }

    this.internMap.set(value, value);
    return value;
  }

  // Internal methods.

  checkNodeId (id) {
    assert(Number.isInteger(id) && id < this.nodes.length);
  }
}
