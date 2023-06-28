/*
 * Parse CC and GC logs.
 */

import { Graph } from './graph.js';
import { poll } from './main.js';
import { assert } from './utils.js';

function ensureGraph (maybeExistingGraph) {
  if (maybeExistingGraph) {
    return maybeExistingGraph;
  }

  return new Graph();
}

export async function parseCCLog (text, maybeGCGraph) {
  const graph = ensureGraph(maybeGCGraph);

  let node;
  let done = false;
  const weakMapEntries = [];

  let count = 0;

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
            throw new Error("Can't find weak map address: " + line);
          }
          if (field === '(nil)') {
            return 0;
          }
          const addr = parseAddr(field);
          return addr;
        });
        if (fields.length !== 4) {
          throw new Error("Can't parse weak map entry: " + line);
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
          throw new Error('Unexpected >');
        }
        if (!node.hasGCData) {
          const addr = parseAddr(words[1]);
          const name = graph.intern(words.slice(2).join(' '));
          let target = getOrCreateNode(graph, addr);
          graph.addEdge(node, target);
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
            throw new Error("Can't parse refcount word: " + line);
          }
          rc = parseInt(match[1]);
          color = '';
          if (Number.isNaN(rc)) {
            throw new Error("Can't parse refcount number: " + match[1]);
          }
          kind = words[2];
        }
        kind = graph.intern(kind);
        node = createOrMergeNode(graph, addr, 'CC', rc, color, kind, line);
        break;
      }
    }

    if (done) {
      break;
    }
  }

  const addressToIdMap = graph.addressToIdMap;
  for (let [line, map, ...fields] of weakMapEntries) {
    const hasMap = map !== 0;
    if (hasMap) {
      const id = addressToIdMap.get(map);
      if (id === undefined) {
        throw new Error('WeakMapEntry map not found: ' + line);
      }
      map = graph.getNode(id);
    }
    const [key, delegate, value] = fields.map(addr => {
      const id = addressToIdMap.get(addr);
      if (id === undefined) {
        // todo: this happens sometimes
        // throw new Error("WeakMapEntry field not found: " + line);
        console.log('WeakMapEntry field not found: ' + line);
        return undefined;
      }
      return graph.getNode(id);
    });

    if (!key || !delegate || !value) {
      continue;
    }

    // Create a fake node for each entry.
    const entry = createNode(graph, 0, 'CC', -1, '', 'WeakMapEntry');
    if (hasMap) {
      graph.addEdge(map, entry, 'WeakMap entry');
    }
    graph.addEdge(key, entry, '(Used as WeakMap key)');
    graph.addEdge(entry, value, 'WeakMap value');
    if (delegate !== key) {
      graph.addEdge(delegate, key, '(Used as WeakMap key delegate)');
    }
  }

  checkAllEdgeTargetsFound(graph);

  return graph;
}

export async function parseGCLog (text, maybeCCGraph) {
  const graph = ensureGraph(maybeCCGraph);

  let node;
  let section;
  let count = 0;
  const roots = [];

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
            throw new Error('Unexpected >');
          }
          if (!node.hasCCData) {
            const addr = parseAddr(words[1]);
            const name = graph.intern(words.slice(3).join(' '));
            let target = getOrCreateNode(graph, addr);
            graph.addEdge(node, target);
          }
          // todo: check match when already have edges from CC log
        } else {
          const addr = parseAddr(words[0]);
          const color = parseGCLogColor(words[1]);
          const kind = graph.intern(words[2]);
          // todo: some kind of name in words[3]
          node = createOrMergeNode(graph, addr, 'GC', -1, color, kind, line);
        }
      } else {
        throw new Error('Bad section: ' + section);
      }
    }
  }

  const addressToIdMap = graph.addressToIdMap;
  for (const words of roots) {
    const addr = parseAddr(words[0]);
    const color = parseGCLogColor(words[1]);
    const name = words[2];

    if (!addressToIdMap.has(addr)) {
      // todo: same bug as processNewEdges
      // throw new Error(`Unknown root address: ${words.join(" ")}`);
      continue;
    }
    const id = addressToIdMap.get(addr);
    const node = graph.getNode(id);
    ensureMatch('address', node.address, addr);

    // Hack: use special hardcoded addresses for dummy root set nodes.
    const setAddr = color === 'black' ? 1 : 2;
    const setName = color === 'black' ? 'Black roots' : 'Gray roots';
    const rootSet = getOrCreateNode(graph, setAddr, 'GC', -1, color, setName);
    graph.addEdge(rootSet, node, name);

    // todo: if we have CC data, don't include gray roots we have information
    // about from the CC log.
  }

  // todo: process weak map entries

  checkAllEdgeTargetsFound(graph);

  return graph;
}

function matchLines (text) {
  return text.matchAll(/[^\n]+/g);
}

function parseAddr (string) {
  if (!string.startsWith('0x')) {
    throw new Error('Expected address: ' + string);
  }
  const addr = parseInt(string.substr(2), 16);
  if (Number.isNaN(addr)) {
    throw new Error("Can't parse address: " + string);
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

  throw new Error('Unrecognised GC log color: ' + string);
}

function parseCCLogColor (string) {
  if (string === '[gc.marked]') {
    return 'black';
  }

  if (string === '[gc]') {
    return 'gray';
  }

  throw new Error('Unrecognised CC log color: ' + string);
}

function createOrMergeNode (graph, addr, logKind, rc, color, kind, line) {
  assert(logKind === 'GC' || logKind === 'CC', 'Bad log kind');

  if (addr === 0) {
    // todo: call directly
    return createNode(graph, addr, logKind, rc, color, kind);
  }

  const addressToIdMap = graph.addressToIdMap;
  if (!addressToIdMap.has(addr)) {
    const node = createNode(graph, addr, logKind, rc, color, kind);
    addressToIdMap.set(addr, node.id);
    return node;
  }

  const id = addressToIdMap.get(addr);
  const node = graph.getNode(id);

  if ((logKind === 'CC' && node.hasCCData) ||
      (logKind === 'GC' && node.hasGCData)) {
    throw new Error('Duplicate node address: ' + line);
  }

  ensureMatch('address', node.address, addr, line);
  
  if (!node.hasGCData && !node.hasCCData) {
    // Populate empty node created by forward reference.
    node.rc = rc;
    node.color = color;
    node.name = kind;
    if (logKind === 'CC') {
      node.hasCCData = true;
    } else {
      node.hasGCData = true;
    }
  } else if (logKind === 'CC') {
    // Merge CC data into existing GC log node.
    node.rc = rc;
    ensureMatch('color', node.color, color, line);
    node.name = kind;
    // todo: should kind match?
    node.hasCCData = true;
  } else {
    // Merge GC data into existing CC log node.
    ensureMatch('color', node.color, color, line);
    // todo: should kind match?
    node.hasGCData = true;
  }

  return node;
}

function getOrCreateNode (graph, addr, logKind, rc, color, kind) {
  assert(logKind === 'GC' || logKind === 'CC' || logKind === undefined,
         'Bad log kind');

  const addressToIdMap = graph.addressToIdMap;
  if (!addressToIdMap.has(addr)) {
    const node = createNode(graph, addr, logKind, rc, color, kind);
    addressToIdMap.set(addr, node.id);
    return node;
  }

  const id = addressToIdMap.get(addr);
  return graph.getNode(id);
}

function createNode (graph, addr, logKind, rc, color, kind) {
  const node = {
    address: addr,
    rc,
    color,
    name: kind,
    root: false,
    visited: false,
    filtered: false,
    selected: false,
    hasCCData: logKind === 'CC',
    hasGCData: logKind === 'GC'
  };
  graph.addNode(node);
  return node;
}

function ensureMatch (field, a, b, line) {
  if (a !== b) {
    throw new Error(`Field '${field}' doesn't match between CC and GC logs: got ${a} and ${b} for ${line}`);
  }
}

function checkAllEdgeTargetsFound(graph) {
  for (const node of graph.nodes) {
    if (!node.hasCCData && !node.hasGCData) {
      throw new Error("Edge target address not found: " + node.address.toString(16));
    }
  }
}
