"use strict";

/*
 * Visualise cycle collector graphs.
 */

const initialLogFile = "demo-graph.log.gz";

let nodes;
let strings;
let addressToIdMap;
let haveCCLog;
let haveGCLog;
let filename;
let config;
let state = "idle";
let inspectorPrev;

function init() {
  document.getElementById("upload").onclick = event => {
    document.getElementById("fileSelect").click();
  };
  document.getElementById("fileSelect").onchange = () => {
    loadLogFile();
  };
  document.getElementById("update").onclick = () => {
    update();
  };
  document.getElementById("toggleLabels").onclick = () => {
    toggleLabels();
  };
  document.getElementById("inspectorClose").onclick = () => {
    closeInspector();
  };

  let updateOnEnter = event => {
    if (event.keyCode === 10 || event.keyCode === 13) {
      document.getElementById("update").click();
    }
  };
  document.getElementById("filter").onkeydown = updateOnEnter;
  document.getElementById("depth").onkeydown = updateOnEnter;
  document.getElementById("limit").onkeydown = updateOnEnter;

  clearData();
  loadFromWeb(initialLogFile, true);
}

function loadLogFile() {
  closeInspector();
  inspectorPrev = undefined;

  clearDisplay();

  let file = document.getElementById("fileSelect").files[0];
  let name = file.name;

  setStatusAndProfile(`Loading ${name}`);

  let isCompressed = name.endsWith(".gz");

  let request = new FileReader();
  request.onerror = event => {
    setErrorStatus(`Error loading ${name}: ${event.message}`);
  };
  request.onprogress = event => {
    const percent = Math.floor(100 * event.loaded / event.total);
    setStatus(`Loading ${percent}%`);
  };
  request.onload = () => {
    if (isCompressed) {
      decompress(name, request.result);
    } else {
      loaded(name, request.result);
    }
  };
  if (isCompressed) {
    request.readAsArrayBuffer(file);
  } else {
    request.readAsText(file);
  }
}

function loadFromWeb(name, isCompressed) {
  let request = new XMLHttpRequest();
  request.onerror = event => {
    setErrorStatus(`Error loading ${name}: ${event.message}`);
  };
  request.onprogress = event => {
    const percent = Math.floor(100 * event.loaded / event.total);
    setStatus(`Loading ${percent}%`);
  };
  request.onload = () => {
    if (isCompressed) {
      decompress(name, request.response);
    } else {
      loaded(name, request.responseText);
    }
  };
  request.open("GET", name);
  if (isCompressed) {
    request.responseType = "arraybuffer";
  }
  request.send();
}

function decompress(name, compressedData) {
  setStatusAndProfile(`Decompressing ${name}`);
  let text;
  try {
    text = pako.inflate(compressedData, { to: 'string' });
  } catch (e) {
    setErrorStatus(`Error decompressing ${name}: ${e}`);
    throw e;
  }
  loaded(name, text);
}

function loaded(name, text) {
  let isFirstUserLoad = filename === initialLogFile;
  filename = name;
  parseLog(text, isFirstUserLoad).then(update).catch(e => {
    setErrorStatus(`Error parsing ${name}: ${e}`);
    throw e;
  });
}

function clearDisplay() {
  for (let element of document.getElementsByTagName("svg")) {
    element.remove();
  }
}

let lastStatus;
let startTime;

function setStatusAndProfile(message) {
  setStatus(message);

  let time = performance.now();
  if (lastStatus) {
    let duration = time - startTime;
    console.log(`${lastStatus} (${duration} ms)`);
  }

  startTime = time;
  lastStatus = message;
}

function setErrorStatus(message) {
  setStatus(message);
  clearProfile();
}

function setStatus(message) {
  document.getElementById("message").textContent = `Status: ${message}`;
}

function clearProfile() {
  lastStatus = undefined;
  startTime = undefined;
}

function clearData() {
  nodes = [];
  strings = new Map();
  addressToIdMap = new Map();
  haveCCLog = false;
  haveGCLog = false;
}

async function parseLog(text, isFirstUserLoad) {
  if (text.startsWith("# WantAllTraces")) {
    if (haveCCLog || isFirstUserLoad) {
      clearData();
    }
    await parseCCLog(text);
    haveCCLog = true;
    return;
  }

  if (text.startsWith("# Roots")) {
    if (haveGCLog || isFirstUserLoad) {
      clearData();
    }
    await parseGCLog(text);
    haveGCLog = true;
    return;
  }

  throw "Unrecognised log file";
}

async function parseCCLog(text) {
  state = "parsing";
  setStatusAndProfile(`Parsing CC log file`);

  let node;
  let done = false;
  let weakMapEntries = [];

  let count = 0;

  let nodesAdded = [];

  for (let match of matchLines(text)) {
    let line = match[0];

    count++;
    if (count % 100000 === 0) {
      setStatus(`Parsing log file: processed ${count} lines`);
      await new Promise(requestAnimationFrame);
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

  state = "idle";
}

async function parseGCLog(text) {
  state = "parsing";
  setStatusAndProfile(`Parsing GC log file`);

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
      setStatus(`Parsing log file: processed ${count} lines`);
      await new Promise(requestAnimationFrame);
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

  state = "idle";
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

async function update() {
  if (state !== "idle") {
    throw "Bad state: " + state;
  }
  state = "updating";

  closeInspector();
  config = readConfig();
  let selectedCount = await selectNodes();
  state = "idle";

  display();
  clearProfile();
}

function readConfig() {
  let filter = document.getElementById("filter").value;
  if (!filter) {
    filter = "";
  }

  let roots = document.getElementById("roots").checked;

  let maxDepth = parseInt(document.getElementById("depth").value);
  if (!maxDepth || Number.isNaN(maxDepth)) {
    maxDepth = 0;
  }

  let incoming = document.getElementById("incoming").checked;
  let outgoing = document.getElementById("outgoing").checked;

  let limit = parseInt(document.getElementById("limit").value);
  if (!limit || Number.isNaN(limit)) {
    limit = 2000;
  }

  let showLabels =
      document.getElementById("toggleLabels").value.startsWith("Hide");

  let allEdges = document.getElementById("allEdges").checked;

  return {filter, roots, maxDepth, incoming, outgoing, limit, showLabels, allEdges};
}

function toggleLabels() {
  config.showLabels = !config.showLabels;
  display();
  document.getElementById("toggleLabels").value =
    `${config.showLabels ? "Hide" : "Show"} labels`;
}

function display() {
  if (state !== "idle") {
    throw "Bad state: " + state;
  }

  setStatusAndProfile(`Building display`);

  let nodeList = getSelectedNodes();
  let links = getLinks(nodes, nodeList);

  let count = nodeList.length;
  let width = Math.max(Math.sqrt(count) * 80, 800);
  let height = width;

  d3.select("svg").remove();
  let body = d3.select("body");
  let svg = body.append("svg")
      .attr("width", width)
      .attr("height", height)

  let defs = svg.append("defs")
      .append("marker")
		  .attr("id", "arrowhead")
		  .attr("viewBox", "0 -5 10 10")
	    .attr("refX", 15)
      .attr("refY", 0)
	    .attr("markerWidth", 10)
	    .attr("markerHeight", 10)
      .attr("orient", "auto")
      .attr("markerUnits", "strokeWidth")
		  .append("path")
		  .attr("d", "M0,-5L10,0L0,5 Z");

  let link = svg.append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(links);
  let linkLine = link
      .enter().append("line")
      .attr("stroke", "black")
		  .attr("marker-end", "url(#arrowhead)");

  link.exit().remove();

  const radius = 10;

  let node = svg.append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodeList);

  let nodeGroup = node
      .enter().append("g");
  nodeGroup.append("circle")
    .attr("r", 5)
    .attr("fill", fillColor)
    .on("click", click)
    .call(d3.drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended));
  if (config.showLabels) {
    nodeGroup.append("text")
      .text(function(d) { return d.name; })
      .attr('x', 6)
      .attr('y', 3);
  }
  nodeGroup.append("title")
    .text(function(d) { return d.fullname; });

  node.exit().remove();

  let simulation = d3.forceSimulation()
      .force("link", d3.forceLink().id(function(d) { return d.id; }).distance(80).strength(1))
      .force("charge", d3.forceManyBody().strength(-10))
      //.force("collision", d3.forceCollide().radius(30))
      .force("center", d3.forceCenter(width / 2, height / 2));

  simulation
      .nodes(nodeList)
      .on("tick", ticked);

  simulation.force("link")
    .links(links);

  function fillColor(d) {
    if (d.filtered) {
      return "#ffee99";
    }

    if (d.root) {
      return "#ffaaaa";
    }

    if (d.rc === -1) {
      return "#aaaaff"; // GC thing.
    }

    return "#aaffaa"; // CC thing.
  }

  let logKind;
  if (haveCCLog && haveGCLog) {
    logKind = "CC and GG"
  } else if (haveCCLog) {
    logKind = "CC";
  } else {
    logKind = "GC";
  }
  setStatusAndProfile(`Displaying ${nodeList.length} out of ${nodes.length} nodes from ${logKind} logs`);

  function ticked() {
    const radius = 10;
    nodeGroup
      .attr("cx", function(d) { return d.x = Math.max(radius, Math.min(width - radius, d.x)); })
      .attr("cy", function(d) { return d.y = Math.max(radius, Math.min(height - radius, d.y)); })
      .attr("transform", function(d) {
        return "translate(" + d.x + "," + d.y + ")";
      })
    linkLine
      .attr("x1", function(d) { return d.source.x; })
      .attr("y1", function(d) { return d.source.y; })
      .attr("x2", function(d) { return d.target.x; })
      .attr("y2", function(d) { return d.target.y; });
  }

  function click(d) {
    let e = d3.event;
    if (e.defaultPrevented) {
      return; // ignore drag
    }

    populateInspector(d);
    openInspector();
  }

  function dragstarted(d) {
    d.fx = d.x;
    d.fy = d.y;
    if (!d3.event.active) {
      simulation.alphaTarget(0.3).restart();
    }
  }

  function dragged(d) {
    d.fx = d3.event.x;
    d.fy = d3.event.y;
  }

  function dragended(d) {
    d.fx = null;
    d.fy = null;
    if (!d3.event.active) {
      simulation.alphaTarget(0);
    }
  }
}

function openInspector() {
  document.getElementById("inspector").style.visibility = "visible";
}

function closeInspector() {
  document.getElementById("inspector").style.visibility = "hidden";
}

function populateInspector(node) {
  let inspector = document.getElementById("inspector");
  while (inspector.childElementCount > 1) {
    inspector.removeChild(inspector.lastChild);
  }

  const maxEdges = 60;

  addInspectorLine(inspector, node.fullname);

  addInspectorButton(inspector, "Hide", () => deselectNode(node));
  addInspectorButton(inspector, "Show adjacent", () => selectRelatedNodes(node, false));
  addInspectorButton(inspector, "Focus", () => selectRelatedNodes(node, true));

  if (inspectorPrev) {
    let prev = inspectorPrev;
    addInspectorButton(inspector, "Find paths from prev", () => selectPathsBetween(node, prev));
  }
  inspectorPrev = node;

  addInspectorButton(inspector, "Find roots", () => selectRootsFromNode(node));

  if (node.rc === -1) {
    addInspectorButton(inspector, "Find CC pred", () => selectCCPredecessor(node));
  } else {
    addInspectorButton(inspector, "Find GC pred", () => selectGCPredecessor(node));
  }

  if (node.outgoingEdges.length) {
    let count = node.outgoingEdges.length;
    addInspectorLine(inspector, `Outgoing edges (${count}):`);
    for (let i = 0; i < Math.min(count, maxEdges); i++) {
      let source = nodes[node.outgoingEdges[i]];
      let name = node.outgoingEdgeNames[i];
      let addr = source.address.toString(16);
      addInspectorLine(inspector, `${name}: 0x${addr} ${source.name}`, 1, source);
    }
    if (count > maxEdges) {
      addInspectorLine(inspector, `...skipped ${count - maxEdges} more...`, 1);
    }
  }

  if (node.incomingEdges.length) {
    let count = node.incomingEdges.length;
    addInspectorLine(inspector, `Incoming edges (${count}):`);
    for (let i = 0; i < Math.min(count, maxEdges); i++) {
      let target = nodes[node.incomingEdges[i]];
      let name = node.incomingEdgeNames[i];
      let addr = target.address.toString(16);
      addInspectorLine(inspector, `0x${addr} ${target.name} ${name}`, 1, target);
    }
    if (count > maxEdges) {
      addInspectorLine(inspector, `...skipped ${count - maxEdges} more...`, 1);
    }
  }
}

function addInspectorLine(inspector, text, indent, node) {
  if (indent) {
    for (let i = 0; i < indent; i++) {
      text = "&nbsp;&nbsp;" + text;
    }
  }
  let elem = document.createElement("p");
  if (node) {
    elem.onclick = () => selectNode(node);
  }

  elem.innerHTML = text;
  inspector.appendChild(elem);
}

function addInspectorButton(inspector, label, handler) {
  let input = document.createElement("input");
  input.type = "button";
  input.value = label;
  input.onclick = handler;
  inspector.appendChild(input);
}

function selectNode(d) {
  if (!d.selected) {
    d.selected = true;
    display();
  }
  populateInspector(d);
}

function deselectNode(d) {
  d.selected = false;
  let related = getRelatedNodes(d, true, true);
  for (let id of related) {
    let node = nodes[id];
    if (!hasSelectedRelatives(node)) {
      node.selected = false;
    }
  }
  display();
  closeInspector();
}

function hasSelectedRelatives(d) {
  let related = getRelatedNodes(d, true, true);
  for (let id of related) {
    let node = nodes[id];
    if (node.selected) {
      return true;
    }
  }
  return false;
}

function selectRelatedNodes(d, hideOthers) {
  if (hideOthers) {
    for (let node of nodes) {
      node.selected = false;
    }
  }
  d.selected = true;
  let related = getRelatedNodes(d, true, true);
  for (let id of related) {
    let node = nodes[id];
    if (!node.selected) {
      node.selected = true;
      node.x = d.x;
      node.y = d.y;
    }
  }
  display();
}

async function selectRootsFromNode(node) {
  selectRoots([node], 0);
  display();
}

async function selectPathsBetween(a, b) {
  console.log(`Selecting paths between ${a.fullname} and ${b.fullname}`);
  selectPathBetween(a, b);
  selectPathBetween(b, a);
  display();
}

async function selectPathBetween(from, to) {
  selectPathWithBFS(from, node => node === to, () => undefined, 0);
}

async function selectGCPredecessor(from) {
  selectPathWithBFS(from, node => node.rc === -1, () => undefined, 0);
  display();
}

async function selectCCPredecessor(from) {
  selectPathWithBFS(from, node => node.rc !== -1, () => undefined, 0);
  display();
}

async function selectNodes() {
  setStatusAndProfile(`Selecting nodes`);

  let count = 0;
  let selected = [];
  for (let d of nodes) {
    d.root = d.incomingEdges.length === 0;
    d.filtered = false;
    d.selected = !filter || d.name === config.filter;
    if (d.selected) {
      if (filter) {
        d.filtered = true;
      }
      count++;
      if (count === config.limit) {
        return count;
      }
      if (config.filter) {
        selected.push(d);
      }
    }
  }

  if (!config.filter) {
    return count;
  }

  if (config.roots) {
    count = await selectRoots(selected, count);
    if (count === config.limit) {
      return count;
    }
  }

  if (config.incoming || config.outgoing) {
    count = selectRelated(selected, count);
    if (count === config.limit) {
      return count;
    }
  }

  return count;
}

async function selectRoots(selected, count) {
  for (let start of selected) {
    setStatus(`Searching for roots for ${start.fullname}`);
    count += selectPathWithBFS(start,
                               node => node.incomingEdges.length === 0,
                               node => { node.root = true; },
                               count);
    if (count === config.limit) {
      break;
    }
  }

  return count;
}

async function selectPathWithBFS(start, predicate, onFound, count) {
  // Perform a BFS from |start| searching for nodes for which
  // |predicate(node)| is true and select nodes along the path found.

  let i = 0;

  for (let node of nodes) {
    node.visited = false;
  }

  let worklist = [{node: start, path: null, length: 0}];

  while (worklist.length) {
    let {node, path, length} = worklist.shift();

    if (node.visited) {
      continue;
    }
    node.visited = true;

    i++;
    if (i % 100000 === 0) {
      setStatus(`Visited ${i} nodes`);
      await new Promise(requestAnimationFrame);
    }

    if (predicate(node)) {
      // Found a root, select nodes on its path.
      console.log(`  Found path of length ${length} from ${node.fullname} to ${start.fullname}`);
      onFound(node);
      do {
        node.selected = true;
        count++;
        if (count === config.limit) {
          return count;
        }

        if (path) {
          node = path.node;
          path = path.next;
        }
      } while (path);

      // Stop at the first root found. This will not report any additional
      // roots but is much faster.
      return count;
    } else  {
      // Queue unvisited incoming nodes.
      let newPath = {node, next: path};
      for (let id of node.incomingEdges) {
        let source = nodes[id];
        if (source === undefined) {
          throw "Incoming edge ID not found";
        }
        if (source.visited) {
          continue;
        }
        let item = {node: source, path: newPath, length: length + 1};
        if (source.selected) {
          // Eager depth first traversal of previously found paths.
          worklist.unshift(item);
        } else {
          worklist.push(item);
        }
      }
    }
  }

  console.log(`  Found no paths to ${start.fullname}`);
  return count;
}

function selectRelated(selected, count) {
  let worklist = selected.map(node => ({node, depth: 0}));

  while (worklist.length) {
    let item = worklist.pop();
    let depth = item.depth + 1;
    if (depth > config.maxDepth) {
      continue;
    }

    let related = getRelatedNodes(item.node, config.incoming, config.outgoing);
    for (let id of related) {
      let node = nodes[id];
      if (!node) {
        throw `Missing node {id}`;
      }
      if (!node.selected) {
        node.selected = true;
        count++;
        if (count === config.limit) {
          return count;
        }
        worklist.push({node: node, depth: depth});
      }
    }
  }

  return count;
}

function getSelectedNodes() {
  let selected = [];
  for (let node of nodes) {
    if (node.selected) {
      selected.push(node);
    }
  }
  return selected;
}

function getRelatedNodes(node, incoming, outgoing) {
  let related = [];
  if (incoming) {
    related = related.concat(node.incomingEdges);
  }
  if (outgoing) {
    related = related.concat(node.outgoingEdges);
  }
  return related;
}

function getLinks(objects, selected) {
  let links = [];
  for (let object of selected) {
    let source = object.id;
    for (let i = 0; i < object.outgoingEdges.length; i++) {
      if (!config.allEdges) {
        // Skip edges from JS objects to global and prototype.
        let kind = object.outgoingEdgeNames[i];
        if (kind === "baseshape_global" || kind === "baseshape_proto") {
          continue;
        }
      }
      let target = object.outgoingEdges[i];
      if (objects[target].selected && source !== target) {
        links.push({source, target});
      }
    }
  }
  return links;
}
