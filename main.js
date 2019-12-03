let simulation;

d3.text("data.log", function(error, data) {
  if (error) {
    throw error;
  }

  let objects = processLog(data);

  display(objects);
});

function processLog(data) {
  let objects = new Map();
  let object;
  let done = false;
  console.log("processing");
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

    default: {
      if (!words[0].startsWith("0x")) {
        throw "Unexpected entry: " + line;
      }
      let addr = parseInt(words[0].substr(2), 16);
      if (Number.isNaN(addr)) {
        throw "Can't parse address: " + line;
      }
      let rc = -1; // => GC object.
      if (words[1] !== "[gc]") {
        let match = words[1].match(/^\[rc=(\d+)\]$/);
        if (!match) {
          throw "Can't parse refcount word: " + line;
        }
        rc = parseInt(match[1]);
        if (Number.isNaN(rc)) {
          throw "Can't parse refcount number: " + match[1];
        }
      }
      let kind = words.slice(2).join(" ");
      object = {id: addr, rc: rc, name: kind, fullname: line, children: []};
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

  console.log("  done.");
  return objects;
}

function display(objects) {
  let count = objects.size;

  let width = Math.sqrt(count) * 120;
  let height = width;

  let body = d3.select("body");
  let svg = body.insert("svg")
      .attr("width", width)
      .attr("height", height)

  let defs = svg.append("defs");

  defs
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
		.attr("d", "M0,-5L10,0L0,5 Z")
    .attr("fill", "#999");

  let nodes = Array.from(objects.values());
  let links = getLinks(objects);

  simulation = d3.forceSimulation()
      .force("link", d3.forceLink().id(function(d) { return d.id; }).distance(30))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("collision", d3.forceCollide().radius(30))
      .force("x", d3.forceX(width / 2))
      .force("y", d3.forceY(height / 2));

  var link = svg.append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(links)
      .enter().append("line")
      .attr("stroke", "black")
		  .attr("marker-end", "url(#arrowhead)");

  let node = svg.append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodes)
      .enter().append("g")

  node.append("circle")
    .attr("r", 5)
    .attr("fill", d => d.rc === -1 ? "#aaaaff" : "#aaffaa")
    .call(d3.drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended));

    /*
  node.append("text")
    .text(function(d) { return d.name; })
    .attr('x', 6)
    .attr('y', 3);
    */
  
  node.append("title")
    .text(function(d) { return d.fullname; });

  simulation
      .nodes(nodes)
      .on("tick", ticked);

  simulation.force("link")
    .links(links);

  function ticked() {
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

function getLinks(objects) {
  let links = [];
  for (let object of objects.values()) {
    for (let child of object.children) {
      if (!objects.has(child.id)) {
        throw "Child id not found";
      }
      links.push({source: object.id, target: child.id});
    }
  }
  return links;
}
