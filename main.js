"use strict";

/*
 * Visualise cycle collector graphs.
 */

let data = [];

const inputURL = "data.log";

function init() {
  document.getElementById("update").onclick = function() {
    update();
  }
  
  setStatus(`Loading ${inputURL}`);

  const request = new XMLHttpRequest();
  request.onerror = function (event) {
    setStatus(`Error loading ${inputURL}: ${event.message}`);
  }
  request.onprogress = function (event) {
    const percent = Math.floor(100 * event.loaded / event.total);
    setStatus(`Loading ${percent}%`);
  }
  request.onload = function loaded() {
    setStatus(`Loaded`);
    data = parseLog(this.responseText);
    update();
  }
  request.open("GET", inputURL);
  request.send();
}

function setStatus(message) {
  document.getElementById("status").textContent = message;
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
  display(data, filter, depth);
}

function display(nodeMap, filter, depth) {
  let count = selectNodes(nodeMap, filter, depth);
  let nodeList = Array.from(nodeMap.values()).filter(d => d.selected);
  let links = getLinks(nodeMap);

  setStatus(`Displaying ${count} out of ${nodeMap.size} nodes`);

  let width = Math.max(Math.sqrt(count) * 120, 800);
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

  let node = svg.append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodeList)
      .enter().append("g")

  node.append("circle")
    .attr("r", 5)
    .attr("fill", d => d.rc === -1 ? "#aaaaff" : "#aaffaa")
    .call(d3.drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended));

  node.append("text")
    .text(function(d) { return d.name; })
    .attr('x', 6)
    .attr('y', 3);
  
  node.append("title")
    .text(function(d) { return d.fullname; });

  var link = svg.append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(links)
      .enter().append("line")
      .attr("stroke", "black")
		  .attr("marker-end", "url(#arrowhead)");

  let simulation = d3.forceSimulation()
      .force("link", d3.forceLink().id(function(d) { return d.id; }).distance(50))
      .force("charge", d3.forceManyBody().strength(-1))
      .force("collision", d3.forceCollide().radius(50))
      .force("center", d3.forceCenter(width / 2, height / 2));

  simulation
      .nodes(nodeList)
      .on("tick", ticked);

  simulation.force("link")
    .links(links);

  function ticked() {
    const radius = 10;
    node
      .attr("cx", function(d) { return d.x = Math.max(radius, Math.min(width - radius, d.x)); })
      .attr("cy", function(d) { return d.y = Math.max(radius, Math.min(height - radius, d.y)); });
    link
      .attr("x1", function(d) { return d.source.x; })
      .attr("y1", function(d) { return d.source.y; })
      .attr("x2", function(d) { return d.target.x; })
      .attr("y2", function(d) { return d.target.y; });

    node
      .attr("transform", function(d) {
        return "translate(" + d.x + "," + d.y + ")";
      })
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

function selectNodes(nodeMap, filter, maxDepth) {
  if (!maxDepth || Number.isNaN(maxDepth)) {
    maxDepth = 0;
  }

  let count = 0;
  let worklist = [];
  for (let d of nodeMap.values()) {
    d.selected = !filter || d.name.includes(filter);
    if (d.selected) {
      count++;
      if (filter) {
        worklist.push({node: d, depth: 0});
      }
    }
  }

  if (!filter) {
    return count;
  }

  while (worklist.length) {
    let item = worklist.pop();
    if (item.depth >= maxDepth) {
      continue;
    }
    let depth = item.depth + 1;
    for (let info of item.node.children.concat(item.node.parents)) {
      let node = nodeMap.get(info.id);
      if (!node) {
        throw `Missing node {id}`;
      }
      if (!node.selected) {
        count++;
        node.selected = true;
        worklist.push({node: node, depth: depth});
      }
    }
  }

  return count;
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
