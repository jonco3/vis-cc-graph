/*
 * Directed graph representation for heap graphs.
 */

import { assert } from './utils.js';

export class Graph {
  constructor () {
    this.nodes = [];
    this.internMap = new Map();
    this.internedValues = [];
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
    const nameId = this.internToId(name);
    sourceNode.outgoingEdges.push(targetNode.id);
    sourceNode.outgoingEdgeNames.push(nameId);
    targetNode.incomingEdges.push(sourceNode.id);
    targetNode.incomingEdgeNames.push(nameId);
  }

  hasOutgoingEdges (node) {
    return node.outgoingEdges.length !== 0;
  }

  forEachOutgoingEdge (node, f) {
    for (let i = 0; i < node.outgoingEdges.length; i++) {
      f(this.getNode(node.outgoingEdges[i]),
        this.getInternedValue(node.outgoingEdgeNames[i]));
    }
  }

  hasIncomingEdges (node) {
    return node.incomingEdges.length !== 0;
  }

  forEachIncomingEdge (node, f) {
    for (let i = 0; i < node.incomingEdges.length; i++) {
      f(this.getNode(node.incomingEdges[i]),
        this.getInternedValue(node.incomingEdgeNames[i]));
    }
  }

  // Utility method to canonicalise a value.
  intern (value) {
    return this.internedValues[this.internToId(value)];
  }

  // Internal methods.

  internToId (value) {
    let id = this.internMap.get(value);
    if (id !== undefined) {
      return id;
    }

    id = this.internedValues.length;
    this.internedValues.push(value);
    this.internMap.set(value, id);
    return id;
  }

  getInternedValue (id) {
    return this.internedValues[id];
  }

  checkNodeId (id) {
    assert(Number.isInteger(id) && id < this.nodes.length);
  }
}
