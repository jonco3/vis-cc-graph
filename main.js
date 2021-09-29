"use strict";

/*
 * Visualise cycle collector graphs.
 */

let nodeMap;
let selectedNodes;
let filename;
let showLabels = true;

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

  loadFromWeb("demo-graph.log.gz", true);
}

function loadLogFile() {
  clearDisplay();

  let file = document.getElementById("fileSelect").files[0];
  let name = file.name;

  setStatus(`Loading ${name}`);

  let isCompressed = name.endsWith(".gz");

  let request = new FileReader();
  request.onerror = event => {
    setStatus(`Error loading ${name}: ${event.message}`);
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
    setStatus(`Error loading ${name}: ${event.message}`);
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
  setStatus(`Decompressing ${name}`);
  let text;
  try {
    text = pako.inflate(compressedData, { to: 'string' });
  } catch (e) {
    setStatus(`Error decompressing ${name}: ${e}`);
    throw e;
  }
  loaded(name, text);
}

function loaded(name, text) {
  filename = name;
  try {
    nodeMap = parseLog(text);
  } catch (e) {
    setStatus(`Error parsing ${name}: ${e}`);
    throw e;
  }
  update();
}

function clearDisplay() {
  for (let element of document.getElementsByTagName("svg")) {
    element.remove();
  }
}

let lastStatus;
let startTime;

function setStatus(message) {
  document.getElementById("message").textContent = `Status: ${message}`;

  if (message.endsWith("%")) {
    return;
  }

  let time = performance.now();
  if (lastStatus) {
    let duration = time - startTime;
    console.log(`${lastStatus} (${duration} ms)`);
  }

  startTime = time;
  lastStatus = message;
}

function parseLog(text) {
  setStatus(`Parsing log file`);

  let objects = new Map();
  let object;
  let done = false;

  const lineRegExp = /[^\n]+/g;

  for (let match of text.matchAll(lineRegExp)) {
    let line = match[0];
    if (line.startsWith("#")) {
      continue;
    }
    let words = line.split(" ");

    switch (words[0]) {
    case "WeakMapEntry": {
      // TODO
      break;
    }

    case ">": {
      if (!object) {
        throw "Unexpected >";
      }
      if (!words[1].startsWith("0x")) {
        throw "Unexpected entry: " + line;
      }
      let addr = parseInt(words[1].substr(2), 16);
      if (Number.isNaN(addr)) {
        throw "Can't parse address: " + line;
      }
      let kind = words.slice(2).join(" ");
      object.outgoingEdges.push({id: addr, name: kind});
      break;
    }

    case "==========": {
      done = true;
      break;
    }

    case "IncrementalRoot": {
      break; // Ignore these.
    }

    default: {
      if (!words[0].startsWith("0x")) {
        throw "Unexpected entry: " + line;
      }
      let addr = parseInt(words[0].substr(2), 16);
      if (Number.isNaN(addr)) {
        throw "Can't parse address: " + line;
      }
      let rc;
      let kind;
      if (words[1].startsWith("[gc")) {
        rc = -1; // => JS GC object.
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
        if (Number.isNaN(rc)) {
          throw "Can't parse refcount number: " + match[1];
        }
        kind = words[2];
      }
      object = {id: addr,
                rc: rc,
                name: kind,
                fullname: line,
                incomingEdges: [],
                outgoingEdges: [],
                selected: false};
      if (objects.has(addr)) {
        throw "Duplicate object address: " + line;
      }
      objects.set(addr, object);
      break;
    }
      
    }

    if (done) {
      break;
    }
  }

  for (let object of objects.values()) {
    for (let info of object.outgoingEdges) {
      objects.get(info.id).incomingEdges.push({id: object.id, name: info.name});
    }
  }

  return objects;
}

function update() {
  setStatus(`Building display`);
  let filter = document.getElementById("filter").value;
  let depth = parseInt(document.getElementById("depth").value);
  let incoming = document.getElementById("incoming").checked;
  let outgoing = document.getElementById("outgoing").checked;
  let limit = parseInt(document.getElementById("limit").value);
  selectedNodes = selectNodes(nodeMap, filter, depth, incoming, outgoing, limit);
  display(nodeMap, selectedNodes, incoming, outgoing);
  setStatus(`Displaying ${selectedNodes.length} out of ${nodeMap.size} nodes of ${filename}`);
  lastStatus = undefined;
}

function toggleLabels() {
  showLabels = !showLabels;
  display(nodeMap, selectedNodes);
  document.getElementById("toggleLabels").value = `${showLabels ? "Hide" : "Show"} labels`;
}

function display(nodeMap, nodeList) {
  let links = getLinks(nodeMap, nodeList);

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
    .attr("fill", d => d.rc === -1 ? "#aaaaff" : "#aaffaa")
    .on("click", click)
    .call(d3.drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended));
  if (showLabels) {
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

    if (e.shiftKey) {
      deselectNode(d);
    } else {
      selectRelatedNodes(d);
    }

    display(nodeMap, nodeList);
  }

  function deselectNode(d) {
    d.selected = false;
    let related = getRelatedNodes(d, incoming, outgoing);
    for (let info of related) {
      let node = nodeMap.get(info.id);
      if (!hasSelectedRelatives(node)) {
        node.selected = false;
      }
    }
  }

  function hasSelectedRelatives(d) {
    let related = getRelatedNodes(d, incoming, outgoing);
    for (let info of related) {
      let node = nodeMap.get(info.id);
      if (node.selected) {
        return true;
      }
    }
    return false;
  }

  function selectRelatedNodes(d) {
    let related = getRelatedNodes(d, incoming, outgoing);
    for (let info of related) {
      let node = nodeMap.get(info.id);
      if (!node.selected) {
        node.selected = true;
        node.x = d.x;
        node.y = d.y;
      }
    }
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

function selectNodes(nodeMap, filter, maxDepth, incoming, outgoing, limit) {
  let selected = [];

  if (!filter) {
    filter = "";
  }

  if (!maxDepth || Number.isNaN(maxDepth)) {
    maxDepth = 0;
  }

  if (!limit || Number.isNaN(limit)) {
    limit = 2000;
  }

  let worklist = [];
  for (let d of nodeMap.values()) {
    d.selected = d.name === filter;
    if (d.selected) {
      selected.push(d);
      if (selected.length === limit) {
        return selected;
      }
      if (filter) {
        worklist.push({node: d, depth: 0});
      }
    }
  }

  if (!filter) {
    return selected;
  }

  while (worklist.length) {
    let item = worklist.pop();
    let depth = item.depth + 1;
    if (depth > maxDepth) {
      continue;
    }

    let related = getRelatedNodes(item.node, incoming, outgoing);
    for (let info of related) {
      let node = nodeMap.get(info.id);
      if (!node) {
        throw `Missing node {id}`;
      }
      if (!node.selected) {
        node.selected = true;
        selected.push(node);
        if (selected.length === limit) {
          return selected;
        }
        worklist.push({node: node, depth: depth});
      }
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
    for (let edge of object.outgoingEdges) {
      if (objects.get(edge.id).selected &&
          object.id !== edge.id) {
        links.push({source: object.id, target: edge.id});
      }
    }
  }
  return links;
}
