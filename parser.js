/*
 * Parse CC and GC logs.
 */

import { poll } from "./main.js";

let nodes;
let strings;
let addressToIdMap;

function maybeInit() {
  if (!nodes) {
    nodes = [];
    strings = new Map();
    addressToIdMap = new Map();
  }
}

export function clear() {
  nodes = undefined;
  strings = undefined;
  addressToIdMap = undefined;
}

export async function parseCCLog(text) {
  maybeInit();

  let node;
  let done = false;
  let weakMapEntries = [];

  let count = 0;

  let nodesAdded = [];

  for (let match of matchLines(text)) {
    let line = match[0];

    count++;
    if (count % 100000 === 0) {
      await poll(`Parsing log file: processed ${count} lines`);
    }

    if (line[0] === "#") {
      continue;
    }

    let words = line.split(" ");

    switch (words[0]) {
    case "==========": {
      done = true;
      break;
    }

    case "WeakMapEntry": {
      words.shift();
      let fields = words.map(w => {
        let field = w.split("=")[1];
        if (field === undefined) {
          throw "Can't find weak map address: " + line;
        }
        if (field === "(nil)") {
          return 0;
        }
        let addr = parseAddr(field);
        return addr;
      });
      if (fields.length !== 4) {
          throw "Can't parse weak map entry: " + line;
      }
      fields.unshift(line);
      weakMapEntries.push(fields);
      break;
    }

    case "IncrementalRoot": {
      break; // Ignore these.
    }

    case ">": {
      if (!node) {
        throw "Unexpected >";
      }
      if (!node.hasGCData) {
        let addr = parseAddr(words[1]);
        let kind = words.slice(2).join(" ");
        kind = internString(kind);
        node.outgoingEdges.push(addr);
        node.outgoingEdgeNames.push(kind);
      }
      break;
    }

    default: {
      let addr = parseAddr(words[0]);
      let rc;
      let color;
      let kind;
      if (words[1].startsWith("[gc")) {
        rc = -1; // => JS GC node.
        color = parseCCLogColor(words[1]);
        kind = words[3];
        if (kind === "Object") {
          kind = words[4];
          if (kind.startsWith('(')) {
            kind = kind.substr(1);
          }
          if (kind.endsWith(')')) {
            kind = kind.substr(0, kind.length - 1);
          }
        }
      } else {
        let match = words[1].match(/^\[rc=(\d+)\]$/);
        if (!match) {
          throw "Can't parse refcount word: " + line;
        }
        rc = parseInt(match[1]);
        color = "";
        if (Number.isNaN(rc)) {
          throw "Can't parse refcount number: " + match[1];
        }
        kind = words[2];
      }
      kind = internString(kind);
      node = getOrCreateNode('CC', addr, rc, color, kind, line);
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

  processNewEdges(nodesAdded);

  for (let [line, map, ...fields] of weakMapEntries) {
    let hasMap = map !== 0;
    if (hasMap) {
      let id = addressToIdMap.get(map);
      if (id === undefined) {
        throw "WeakMapEntry map not found: " + line;
      }
      map = nodes[id];
    }
    let [key, delegate, value] = fields.map(addr => {
      let id = addressToIdMap.get(addr);
      if (id === undefined) {
        throw "WeakMapEntry field not found: " + line;
      }
      return nodes[id];
    });

    // Create a fake node for each entry.
    let entry = getOrCreateNode('CC', 0, -1, "", "WeakMapEntry", line);
    if (hasMap) {
      createEdge(map, entry, "WeakMap entry");
    }
    createEdge(key, entry, "(Used as WeakMap key)");
    createEdge(entry, value, "WeakMap value");
    if (delegate !== key) {
      createEdge(delegate, key, "(Used as WeakMap key delegate)");
    }
  }

  return nodes;
}

export async function parseGCLog(text) {
  maybeInit();

  let node;
  let weakMapEntries = [];

  let section;

  let count = 0;

  let roots = [];
  let nodesAdded = [];

  for (let match of matchLines(text)) {
    let line = match[0];

    count++;
    if (count % 100000 === 0) {
      await poll(`Parsing log file: processed ${count} lines`);
    }

    if (line === "# Roots.") {
      section = "roots";
    } else if (line === "# Weak maps.") {
      section = "weakmaps";
    } else if (line === "==========") {
      section = "main";
    } else if (line[0] === "#") {
      continue;
    } else {
      let words = line.split(" ");

      if (section === "roots") {
        roots.push(words);
      } else if (section === "weakmaps") {
        // todo: handle weakmaps
      } else if (section === "main") {
        if (words[0] === ">") {
          if (!node) {
            throw "Unexpected >";
          }
          if (!node.hasCCData) {
            let addr = parseAddr(words[1]);
            let kind = words.slice(3).join(" ");
            node.outgoingEdges.push(addr);
            node.outgoingEdgeNames.push(kind);
          }
          // todo: check match when already have edges from CC log
        } else {
          let addr = parseAddr(words[0]);
          let color = parseGCLogColor(words[1]);
          let kind = internString(words[2]);
          let someKindOfName = words[3]; // todo where to put this?
          node = getOrCreateNode('GC', addr, -1, color, kind, line);
          if (!node.hasCCData) {
            nodesAdded.push(node);
          }
        }
      } else {
        throw "Bad section: " + section;
      }
    }
  }

  processNewEdges(nodesAdded);

  /* todo: process weak map entries */

  return nodes;
}

function matchLines(text) {
  return text.matchAll(/[^\n]+/g);
}

function parseAddr(string) {
  if (!string.startsWith("0x")) {
    throw "Expected address: " + string;
  }
  let addr = parseInt(string.substr(2), 16);
  if (Number.isNaN(addr)) {
    throw "Can't parse address: " + string;
  }
  return addr;
}

function parseGCLogColor(string) {
  if (string === "B") {
    return "black";
  }

  if (string === "G") {
    return "gray";
  }

  throw "Unrecognised GC log color: " + string;
}

function parseCCLogColor(string) {
  if (string === "[gc.marked]") {
    return "black";
  }

  if (string === "[gc]") {
    return "gray";
  }

  throw "Unrecognised CC log color: " + string;
}

function internString(s) {
  let result = strings.get(s);
  if (result !== undefined) {
    return result;
  }

  strings.set(s, s);
  return s;
}

function getOrCreateNode(logKind, addr, rc, color, kind, line) {
  if (logKind !== 'GC' && logKind !== 'CC') {
    throw "Bad log kind";
  }

  if (addr === 0) {
    return createNode(logKind, addr, rc, color, kind, line);
  }

  if (!addressToIdMap.has(addr)) {
    let node = createNode(logKind, addr, rc, color, kind, line);
    addressToIdMap.set(addr, node.id);
    return node;
  }

  let id = addressToIdMap.get(addr);
  let node = nodes[id];
  if (!node) {
    throw `Node not found for address 0x${addr.toString(16)} id ${id}`;
  }

  if ((logKind === 'CC' && node.hasCCData) ||
      (logKind === 'GC' && node.hasGCData)) {
    throw "Duplicate node address: " + line;
  }

  if (logKind === 'CC') {
    // Merge CC data into existing GC log node.
    ensureMatch("address", node.address, addr, line);
    node.rc = rc;
    ensureMatch("color", node.color, color, line);
    node.name = kind;
    node.fullname = line + " / " + node.fullname;
    node.hasCCData = true;
  } else {
    // Merge GC data into existing CC log node.
    ensureMatch("address", node.address, addr, line);
    ensureMatch("color", node.color, color, line);
    node.fullname = node.fullname + " / " + line;
    node.hasGCData = true;
  }

  return node;
}

function createNode(logKind, addr, rc, color, kind, line) {
  let node = {id: nodes.length,
              address: addr,
              rc,
              color,
              name: kind,
              fullname: line,
              incomingEdges: [],
              incomingEdgeNames: [],
              outgoingEdges: [],
              outgoingEdgeNames: [],
              root: false,
              visited: false,
              filtered: false,
              selected: false,
              hasCCData: logKind === 'CC',
              hasGCData: logKind === 'GC'};
  nodes.push(node);
  return node;
}

function ensureMatch(field, a, b, line) {
  if (a !== b) {
    throw `Field '${field}' doesn't match between CC and GC logs: got ${a} and ${b} for ${line}`;
  }
}

function createEdge(source, target, name) {
  // Must be called after edge address are replaced with ids!
  source.outgoingEdges.push(target.id);
  source.outgoingEdgeNames.push(name);
  target.incomingEdges.push(source.id);
  target.incomingEdgeNames.push(name);
}

function processNewEdges(newNodes) {
  for (let node of newNodes) {
    let edges = node.outgoingEdges;

    // TODO: Some GC things aren't present in the heap dump and so we ignore
    // them here. This is a JS engine bug.
    let names = node.outgoingEdgeNames;
    node.outgoingEdges = []
    node.outgoingEdgeNames = [];

    for (let i = 0; i < edges.length; i++) {
      // Replace address with id.
      let addr = edges[i];
      let name = names[i];
      let id = addressToIdMap.get(addr);

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
      let target = nodes[id];
      target.incomingEdges.push(node.id);
      target.incomingEdgeNames.push(name);
    }
  }
}
