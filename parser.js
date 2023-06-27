/*
 * Parse CC and GC logs.
 */

import { poll } from './main.js';

function ensureGraph (maybeExistingGraph) {
  if (maybeExistingGraph) {
    return maybeExistingGraph;
  }

  const graph = [];
  graph.stringMap = new Map();
  graph.addressToIdMap = new Map();

  return graph;
}

export async function parseCCLog (text, maybeGCGraph) {
  const graph = ensureGraph(maybeGCGraph);

  let node;
  let done = false;
  const weakMapEntries = [];

  let count = 0;

  const nodesAdded = [];

  for (const match of matchLines(text)) {
    const line = match[0];

    count++;
    if (count % 100000 === 0) {
      await poll(`Parsing log file: processed ${count} lines`);
    }

    if (line[0] === '#') {
      continue;
    }

    const words = line.split(' ');

    switch (words[0]) {
      case '==========': {
        done = true;
        break;
      }

      case 'WeakMapEntry': {
        words.shift();
        const fields = words.map(w => {
          const field = w.split('=')[1];
          if (field === undefined) {
            throw "Can't find weak map address: " + line;
          }
          if (field === '(nil)') {
            return 0;
          }
          const addr = parseAddr(field);
          return addr;
        });
        if (fields.length !== 4) {
          throw "Can't parse weak map entry: " + line;
        }
        fields.unshift(line);
        weakMapEntries.push(fields);
        break;
      }

      case 'IncrementalRoot': {
        break; // Ignore these.
      }

      case '>': {
        if (!node) {
          throw 'Unexpected >';
        }
        if (!node.hasGCData) {
          const addr = parseAddr(words[1]);
          const kind = internString(graph, words.slice(2).join(' '));
          node.outgoingEdges.push(addr);
          node.outgoingEdgeNames.push(kind);
        }
        break;
      }

      default: {
        const addr = parseAddr(words[0]);
        let rc;
        let color;
        let kind;
        if (words[1].startsWith('[gc')) {
          rc = -1; // => JS GC node.
          color = parseCCLogColor(words[1]);
          kind = words[3];
          if (kind === 'Object') {
            kind = words[4];
            if (kind.startsWith('(')) {
              kind = kind.substr(1);
            }
            if (kind.endsWith(')')) {
              kind = kind.substr(0, kind.length - 1);
            }
          }
        } else {
          const match = words[1].match(/^\[rc=(\d+)\]$/);
          if (!match) {
            throw "Can't parse refcount word: " + line;
          }
          rc = parseInt(match[1]);
          color = '';
          if (Number.isNaN(rc)) {
            throw "Can't parse refcount number: " + match[1];
          }
          kind = words[2];
        }
        kind = internString(graph, kind);
        node = createOrMergeNode(graph, 'CC', addr, rc, color, kind, line);
        if (!node.hasGCData) {
          nodesAdded.push(node);
        }
        break;
      }
    }

    if (done) {
      break;
    }
  }

  processNewEdges(graph, nodesAdded);

  const addressToIdMap = graph.addressToIdMap;
  for (let [line, map, ...fields] of weakMapEntries) {
    const hasMap = map !== 0;
    if (hasMap) {
      const id = addressToIdMap.get(map);
      if (id === undefined) {
        throw 'WeakMapEntry map not found: ' + line;
      }
      map = graph[id];
    }
    const [key, delegate, value] = fields.map(addr => {
      const id = addressToIdMap.get(addr);
      if (id === undefined) {
        // todo: this happens sometimes
        // throw "WeakMapEntry field not found: " + line;
        console.log('WeakMapEntry field not found: ' + line);
        return undefined;
      }
      return graph[id];
    });

    if (!key || !delegate || !value) {
      continue;
    }

    // Create a fake node for each entry.
    const entry = createNode(graph, 'CC', 0, -1, '', 'WeakMapEntry');
    if (hasMap) {
      createEdge(map, entry, 'WeakMap entry');
    }
    createEdge(key, entry, '(Used as WeakMap key)');
    createEdge(entry, value, 'WeakMap value');
    if (delegate !== key) {
      createEdge(delegate, key, '(Used as WeakMap key delegate)');
    }
  }

  return graph;
}

export async function parseGCLog (text, maybeCCGraph) {
  const graph = ensureGraph(maybeCCGraph);

  let node;
  let section;
  let count = 0;
  const roots = [];
  const nodesAdded = [];

  for (const match of matchLines(text)) {
    const line = match[0];

    count++;
    if (count % 100000 === 0) {
      await poll(`Parsing log file: processed ${count} lines`);
    }

    if (line === '# Roots.') {
      section = 'roots';
    } else if (line === '# Weak maps.') {
      section = 'weakmaps';
    } else if (line === '==========') {
      section = 'main';
    } else if (line[0] === '#') {
      continue;
    } else if (line === '{') {
      // Ignore extra JSON data after end of log.
      break;
    } else {
      const words = line.split(' ');

      if (section === 'roots') {
        roots.push(words);
      } else if (section === 'weakmaps') {
        // todo: handle weakmaps
      } else if (section === 'main') {
        if (words[0] === '>') {
          if (!node) {
            throw 'Unexpected >';
          }
          if (!node.hasCCData) {
            const addr = parseAddr(words[1]);
            const kind = internString(graph, words.slice(3).join(' '));
            node.outgoingEdges.push(addr);
            node.outgoingEdgeNames.push(kind);
          }
          // todo: check match when already have edges from CC log
        } else {
          const addr = parseAddr(words[0]);
          const color = parseGCLogColor(words[1]);
          const kind = internString(graph, words[2]);
          // todo: some kind of name in words[3]
          node = createOrMergeNode(graph, 'GC', addr, -1, color, kind, line);
          if (!node.hasCCData) {
            nodesAdded.push(node);
          }
        }
      } else {
        throw 'Bad section: ' + section;
      }
    }
  }

  processNewEdges(graph, nodesAdded);

  const addressToIdMap = graph.addressToIdMap;
  for (const words of roots) {
    const addr = parseAddr(words[0]);
    const color = parseGCLogColor(words[1]);
    const name = words[2];

    if (!addressToIdMap.has(addr)) {
      // todo: same bug as processNewEdges
      // throw `Unknown root address: ${words.join(" ")}`;
      continue;
    }
    const id = addressToIdMap.get(addr);
    const node = graph[id];
    ensureMatch('address', node.address, addr);

    // Hack: use special hardcoded addresses for dummy root set nodes.
    const setAddr = color === 'black' ? 1 : 2;
    const setName = color === 'black' ? 'Black roots' : 'Gray roots';
    const rootSet = getOrCreateNode(graph, 'GC', setAddr, -1, color, setName);
    createEdge(rootSet, node, name);

    // todo: if we have CC data, don't include gray roots we have information
    // about from the CC log.
  }

  // todo: process weak map entries

  return graph;
}

function matchLines (text) {
  return text.matchAll(/[^\n]+/g);
}

function parseAddr (string) {
  if (!string.startsWith('0x')) {
    throw 'Expected address: ' + string;
  }
  const addr = parseInt(string.substr(2), 16);
  if (Number.isNaN(addr)) {
    throw "Can't parse address: " + string;
  }
  return addr;
}

function parseGCLogColor (string) {
  if (string === 'B') {
    return 'black';
  }

  if (string === 'G') {
    return 'gray';
  }

  throw 'Unrecognised GC log color: ' + string;
}

function parseCCLogColor (string) {
  if (string === '[gc.marked]') {
    return 'black';
  }

  if (string === '[gc]') {
    return 'gray';
  }

  throw 'Unrecognised CC log color: ' + string;
}

function internString (graph, s) {
  const result = graph.stringMap.get(s);
  if (result !== undefined) {
    return result;
  }

  graph.stringMap.set(s, s);
  return s;
}

function createOrMergeNode (graph, logKind, addr, rc, color, kind, line) {
  if (logKind !== 'GC' && logKind !== 'CC') {
    throw 'Bad log kind';
  }

  if (addr === 0) {
    return createNode(graph, logKind, addr, rc, color, kind);
  }

  const addressToIdMap = graph.addressToIdMap;
  if (!addressToIdMap.has(addr)) {
    const node = createNode(graph, logKind, addr, rc, color, kind);
    addressToIdMap.set(addr, node.id);
    return node;
  }

  const id = addressToIdMap.get(addr);
  const node = graph[id];
  if (!node) {
    throw `Node not found for address 0x${addr.toString(16)} id ${id}`;
  }

  if ((logKind === 'CC' && node.hasCCData) ||
      (logKind === 'GC' && node.hasGCData)) {
    throw 'Duplicate node address: ' + line;
  }

  if (logKind === 'CC') {
    // Merge CC data into existing GC log node.
    ensureMatch('address', node.address, addr, line);
    node.rc = rc;
    ensureMatch('color', node.color, color, line);
    node.name = kind;
    node.hasCCData = true;
  } else {
    // Merge GC data into existing CC log node.
    ensureMatch('address', node.address, addr, line);
    ensureMatch('color', node.color, color, line);
    node.hasGCData = true;
  }

  return node;
}

function getOrCreateNode (graph, logKind, addr, rc, color, kind) {
  if (logKind !== 'GC' && logKind !== 'CC') {
    throw 'Bad log kind';
  }

  const addressToIdMap = graph.addressToIdMap;
  if (!addressToIdMap.has(addr)) {
    const node = createNode(graph, logKind, addr, rc, color, kind);
    addressToIdMap.set(addr, node.id);
    return node;
  }

  const id = addressToIdMap.get(addr);
  const node = graph[id];
  if (!node) {
    throw `Node not found for address 0x${addr.toString(16)} id ${id}`;
  }

  return node;
}

function createNode (graph, logKind, addr, rc, color, kind) {
  const node = {
    id: graph.length,
    address: addr,
    rc,
    color,
    name: kind,
    incomingEdges: [],
    incomingEdgeNames: [],
    outgoingEdges: [],
    outgoingEdgeNames: [],
    root: false,
    visited: false,
    filtered: false,
    selected: false,
    hasCCData: logKind === 'CC',
    hasGCData: logKind === 'GC'
  };
  graph.push(node);
  return node;
}

function ensureMatch (field, a, b, line) {
  if (a !== b) {
    throw `Field '${field}' doesn't match between CC and GC logs: got ${a} and ${b} for ${line}`;
  }
}

function createEdge (source, target, name) {
  // Must be called after edge address are replaced with ids!
  source.outgoingEdges.push(target.id);
  source.outgoingEdgeNames.push(name);
  target.incomingEdges.push(source.id);
  target.incomingEdgeNames.push(name);
}

function processNewEdges (graph, newNodes) {
  for (const node of newNodes) {
    const edges = node.outgoingEdges;

    // TODO: Some GC things aren't present in the heap dump and so we ignore
    // them here. This is a JS engine bug.
    const names = node.outgoingEdgeNames;
    node.outgoingEdges = [];
    node.outgoingEdgeNames = [];

    for (let i = 0; i < edges.length; i++) {
      // Replace address with id.
      const addr = edges[i];
      const name = names[i];
      const id = graph.addressToIdMap.get(addr);

      /*
      if (id === undefined) {
        throw "Edge target address not found: " + addr.toString(16);
      }
      edges[i] = id;
      */
      if (id === undefined) {
        continue;
      }
      node.outgoingEdges.push(id);
      node.outgoingEdgeNames.push(name);

      // Add incoming edge to target.
      const target = graph[id];
      target.incomingEdges.push(node.id);
      target.incomingEdgeNames.push(name);
    }
  }
}
