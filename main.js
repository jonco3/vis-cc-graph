"use strict";

/*
 * Visualise cycle collector graphs.
 */

let data;
let filename;
let showLabels = true;

function init() {
  document.getElementById("fileMenu").onchange = event => {
    if (event.target.value === "upload") {
      document.getElementById("fileSelect").click();
    } else {
      load();
    }
  };
  document.getElementById("fileSelect").onchange = () => {
    load();
  };
  document.getElementById("update").onclick = () => {
    update();
  };
  document.getElementById("toggleLabels").onclick = () => {
    toggleLabels();
  };

  load();
}

function load() {
  for (let element of document.getElementsByTagName("svg")) {
    element.remove();
  }

  let name, file;
  let fileMenu = document.getElementById("fileMenu");
  let index = fileMenu.selectedIndex;
  switch (index) {
  case 0:
    name = "demo-graph.log.gz";
    break;
  case 1:
    file = document.getElementById("fileSelect").files[0];
    name = file.name;
    break;
  }

  setStatus(`Loading ${name}`);

  let isCompressed = name.endsWith(".gz");

  if (file) {
    loadFromUser(file, name, isCompressed);
  } else {
    loadFromWeb(name, isCompressed);
  }
}

function loadFromUser(file, name, isCompressed) {
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
  setStatus(`Loaded ${name}`);
  try {
    data = parseLog(text);
  } catch (e) {
    setStatus(`Error parsing ${name}: ${e}`);
    throw e;
  }
  update();
}

function setStatus(message) {
  document.getElementById("message").textContent = `Status: ${message}`;
}

function parseLog(data) {
  let objects = new Map();
  let object;
  let done = false;

  for (let line of data.split("\n")) {
    if (line === "" || line.startsWith("#")) {
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
      object.children.push({id: addr, name: kind});
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
      let rc = -1; // => GC object.
      if (!words[1].startsWith("[gc")) {
        let match = words[1].match(/^\[rc=(\d+)\]$/);
        if (!match) {
          throw "Can't parse refcount word: " + line;
        }
        rc = parseInt(match[1]);
        if (Number.isNaN(rc)) {
          throw "Can't parse refcount number: " + match[1];
        }
      }
      let kind = words[2];
      object = {id: addr,
                rc: rc,
                name: kind,
                fullname: line,
                children: [],
                parents: [],
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
    for (let info of object.children) {
      objects.get(info.id).parents.push({id: object.id, name: info.name});
    }
  }

  return objects;
}

function update() {
  let filter = document.getElementById("filter").value;
  let depth = parseInt(document.getElementById("depth").value);
  let incoming = document.getElementById("incoming").checked;
  let outgoing = document.getElementById("outgoing").checked;
  let limit = parseInt(document.getElementById("limit").value);
  selectNodes(data, filter, depth, incoming, outgoing, limit);
  display(data, incoming, outgoing);
}

function toggleLabels() {
  showLabels = !showLabels;
  display(data);
  document.getElementById("toggleLabels").value = `${showLabels ? "Hide" : "Show"} labels`;
}

function display(nodeMap) {
  let nodeList = Array.from(nodeMap.values()).filter(d => d.selected);
  let links = getLinks(nodeMap);

  let count = nodeList.length;
  setStatus(`Displaying ${count} out of ${nodeMap.size} nodes of ${filename}`);

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

    display(nodeMap);
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
  if (!filter) {
    filter = "";
  }

  if (!maxDepth || Number.isNaN(maxDepth)) {
    maxDepth = 0;
  }

  if (!limit || Number.isNaN(limit)) {
    limit = 2000;
  }

  let count = 0;
  let worklist = [];
  for (let d of nodeMap.values()) {
    d.selected = d.name.includes(filter) && count < limit;
    if (d.selected) {
      count++;
      if (filter) {
        worklist.push({node: d, depth: 0});
      }
    }
  }

  if (!filter || count === limit) {
    return;
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
        count++;
        if (count >= limit) {
          return;
        }
        worklist.push({node: node, depth: depth});
      }
    }
  }
}

function getRelatedNodes(node, incoming, outgoing) {
  let related = [];
  if (incoming) {
    related = related.concat(node.parents);
  }
  if (outgoing) {
    related = related.concat(node.children);
  }
  return related;
}

function getLinks(objects) {
  let links = [];
  for (let object of objects.values()) {
    for (let child of object.children) {
      if (!objects.has(child.id)) {
        throw `Child ${child.id} not found`;
      }
      if (object.selected && objects.get(child.id).selected &&
          object.id !== child.id) {
        links.push({source: object.id, target: child.id});
      }
    }
  }
  return links;
}
