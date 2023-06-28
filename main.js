/*
 * Visualise cycle collector graphs.
 */

import * as parser from './parser.js';

const initialLogFile = 'demo-graph.log.gz';

let graph;
let haveCCLog;
let haveGCLog;
let ccLogFilename = '';
let gcLogFilename = '';
let config;
let state = 'idle';
let inspectorPrev;
let loadCount = 0;

window.onload = () => {
  document.getElementById('upload').onclick = event => {
    document.getElementById('fileSelect').click();
  };
  document.getElementById('fileSelect').onchange = () => {
    loadLogFile();
  };
  document.getElementById('update').onclick = () => {
    update();
  };
  document.getElementById('toggleLabels').onclick = () => {
    toggleLabels();
  };
  document.getElementById('inspectorClose').onclick = () => {
    closeInspector();
  };

  const updateOnEnter = event => {
    if (event.keyCode === 10 || event.keyCode === 13) {
      document.getElementById('update').click();
    }
  };
  document.getElementById('filter').onkeydown = updateOnEnter;
  document.getElementById('depth').onkeydown = updateOnEnter;
  document.getElementById('limit').onkeydown = updateOnEnter;

  clearData();
  loadFromWeb(initialLogFile, true);
};

function loadLogFile () {
  closeInspector();
  inspectorPrev = undefined;

  clearDisplay();

  const file = document.getElementById('fileSelect').files[0];
  const name = file.name;

  setStatus(`Loading ${name}`);

  const isCompressed = name.endsWith('.gz');

  const request = new FileReader();
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

function loadFromWeb (name, isCompressed) {
  const request = new XMLHttpRequest();
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
  request.open('GET', name);
  if (isCompressed) {
    request.responseType = 'arraybuffer';
  }
  request.send();
}

function decompress (name, compressedData) {
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

function loaded (name, text) {
  loadCount++;
  parseLog(name, text, loadCount === 2).then(update).catch(e => {
    clearData();
    setStatus(`Error parsing ${name}: ${e}`);
    throw e;
  });
}

function clearDisplay () {
  for (const element of document.getElementsByTagName('svg')) {
    element.remove();
  }
}

function setStatus (message) {
  document.getElementById('message').textContent = `Status: ${message}`;
}

// Called peridically in long running functions so the browser doesn't freeze
// up while we're busy.
export async function poll (message) {
  setStatus(message);
  return new Promise(requestAnimationFrame);
}

function clearData () {
  console.log('Clearing all data');
  graph = undefined;
  haveCCLog = false;
  haveGCLog = false;
  gcLogFilename = '';
  ccLogFilename = '';
}

async function parseLog (filename, text, isFirstUserLoad) {
  if (text.startsWith('# WantAllTraces')) {
    // Cycle collector log.
    if (haveCCLog || isFirstUserLoad) {
      clearData();
    }
    state = 'parsing';
    setStatus('Parsing CC log file');
    graph = await parser.parseCCLog(text, graph);
    state = 'idle';
    haveCCLog = true;
    ccLogFilename = filename;
    updateFilenameDisplay();
    return;
  }

  if (text.startsWith('# Roots')) {
    // Garbage collector log.
    if (haveGCLog || isFirstUserLoad) {
      clearData();
    }
    state = 'parsing';
    setStatus('Parsing GC log file');
    graph = await parser.parseGCLog(text, graph);
    state = 'idle';
    haveGCLog = true;
    gcLogFilename = filename;
    updateFilenameDisplay();
    return;
  }

  throw new Error('Unrecognised log file');
}

function updateFilenameDisplay () {
  const elements = [];
  if (haveCCLog) {
    elements.push(ccLogFilename);
  }
  if (haveGCLog) {
    elements.push(gcLogFilename);
  }
  document.getElementById('filename').textContent = 'Loaded: ' + elements.join(', ');
}

async function update () {
  if (state !== 'idle') {
    throw new Error('Bad state: ' + state);
  }
  state = 'updating';

  closeInspector();
  config = readConfig();
  await selectNodes();
  state = 'idle';

  display();
}

function readConfig () {
  let filter = document.getElementById('filter').value;
  if (!filter) {
    filter = '';
  }

  const roots = document.getElementById('roots').checked;

  let maxDepth = parseInt(document.getElementById('depth').value);
  if (!maxDepth || Number.isNaN(maxDepth)) {
    maxDepth = 0;
  }

  const incoming = document.getElementById('incoming').checked;
  const outgoing = document.getElementById('outgoing').checked;

  let limit = parseInt(document.getElementById('limit').value);
  if (!limit || Number.isNaN(limit)) {
    limit = 2000;
  }

  const showLabels =
      document.getElementById('toggleLabels').value.startsWith('Hide');

  const allEdges = document.getElementById('allEdges').checked;

  return { filter, roots, maxDepth, incoming, outgoing, limit, showLabels, allEdges };
}

function toggleLabels () {
  config.showLabels = !config.showLabels;
  display();
  document.getElementById('toggleLabels').value =
    `${config.showLabels ? 'Hide' : 'Show'} labels`;
}

function fullname (node) {
  let name = `0x${node.address.toString(16)} ${node.color} ${node.name}`;
  if (node.hasCCData) {
    name += ` rc=${node.rc}`;
  }
  return name;
}

function display () {
  if (state !== 'idle') {
    throw new Error('Bad state: ' + state);
  }

  setStatus('Building display');

  const nodeList = getSelectedNodes();
  const links = getLinks(graph, nodeList);

  const count = nodeList.length;
  const width = Math.max(Math.sqrt(count) * 80, 800);
  const height = width;

  d3.select('svg').remove();
  const body = d3.select('body');
  const svg = body.append('svg')
    .attr('width', width)
    .attr('height', height);

  svg.append('defs')
    .append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 15)
    .attr('refY', 0)
    .attr('markerWidth', 10)
    .attr('markerHeight', 10)
    .attr('orient', 'auto')
    .attr('markerUnits', 'strokeWidth')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5 Z');

  const link = svg.append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(links);
  const linkLine = link
    .enter().append('line')
    .attr('stroke', 'black')
    .attr('marker-end', 'url(#arrowhead)');

  link.exit().remove();

  const node = svg.append('g')
    .attr('class', 'nodes')
    .selectAll('g')
    .data(nodeList);

  const nodeGroup = node
    .enter().append('g');
  nodeGroup.append('circle')
    .attr('r', 5)
    .attr('fill', fillColor)
    .on('click', click)
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));
  if (config.showLabels) {
    nodeGroup.append('text')
      .text(function (d) { return d.name; })
      .attr('x', 6)
      .attr('y', 3);
  }
  nodeGroup.append('title')
    .text(function (d) { return fullname(d); });

  node.exit().remove();

  const simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id(function (d) { return d.id; }).distance(80).strength(1))
    .force('charge', d3.forceManyBody().strength(-10))
  // .force("collision", d3.forceCollide().radius(30))
    .force('center', d3.forceCenter(width / 2, height / 2));

  simulation
    .nodes(nodeList)
    .on('tick', ticked);

  simulation.force('link')
    .links(links);

  function fillColor (d) {
    if (d.filtered) {
      return '#ffee99';
    }

    if (d.root) {
      return '#ffaaaa';
    }

    if (d.rc === -1) {
      return '#aaaaff'; // GC thing.
    }

    return '#aaffaa'; // CC thing.
  }

  let logKind;
  if (haveCCLog && haveGCLog) {
    logKind = 'CC and GG';
  } else if (haveCCLog) {
    logKind = 'CC';
  } else {
    logKind = 'GC';
  }
  setStatus(`Displaying ${nodeList.length} out of ${graph.nodeCount()} nodes from ${logKind} logs`);

  function ticked () {
    nodeGroup
      .attr('transform', function (d) {
        return 'translate(' + d.x + ',' + d.y + ')';
      });
    linkLine
      .attr('x1', function (d) { return d.source.x; })
      .attr('y1', function (d) { return d.source.y; })
      .attr('x2', function (d) { return d.target.x; })
      .attr('y2', function (d) { return d.target.y; });
  }

  function click (d) {
    const e = d3.event;
    if (e.defaultPrevented) {
      return; // ignore drag
    }

    populateInspector(d);
    openInspector();
  }

  function dragstarted (d) {
    d.fx = d.x;
    d.fy = d.y;
    if (!d3.event.active) {
      simulation.alphaTarget(0.3).restart();
    }
  }

  function dragged (d) {
    d.fx = d3.event.x;
    d.fy = d3.event.y;
  }

  function dragended (d) {
    d.fx = null;
    d.fy = null;
    if (!d3.event.active) {
      simulation.alphaTarget(0);
    }
  }
}

function openInspector () {
  document.getElementById('inspector').style.visibility = 'visible';
}

function closeInspector () {
  document.getElementById('inspector').style.visibility = 'hidden';
}

function populateInspector (node) {
  const inspector = document.getElementById('inspector');
  while (inspector.childElementCount > 1) {
    inspector.removeChild(inspector.lastChild);
  }

  const maxEdges = 60;

  addInspectorLine(inspector, fullname(node));

  addInspectorButton(inspector, 'Hide', () => deselectNode(node));
  addInspectorButton(inspector, 'Show adjacent', () => selectRelatedNodes(node, false));
  addInspectorButton(inspector, 'Focus', () => selectRelatedNodes(node, true));

  if (inspectorPrev) {
    const prev = inspectorPrev;
    addInspectorButton(inspector, 'Find paths from prev', () => selectPathsBetween(node, prev));
  }
  inspectorPrev = node;

  addInspectorButton(inspector, 'Find roots', () => selectRootsFromNode(node));

  if (node.rc === -1) {
    addInspectorButton(inspector, 'Find CC pred', () => selectCCPredecessor(node));
  } else {
    addInspectorButton(inspector, 'Find GC pred', () => selectGCPredecessor(node));
  }

  if (graph.hasOutgoingEdges(node)) {
    let count = 0;
    addInspectorLine(inspector, `Outgoing edges (${count}):`);
    graph.forEachOutgoingEdge(node, (target, name) => {
      count++;
      if (count <= maxEdges) {
        const addr = target.address.toString(16);
        addInspectorLine(inspector, `${name}: 0x${addr} ${target.name}`, 1, target);
      }
    });
    if (count > maxEdges) {
      addInspectorLine(inspector, `...skipped ${count - maxEdges} more...`, 1);
    }
  }

  if (graph.hasIncomingEdges(node)) {
    let count = 0;
    addInspectorLine(inspector, `Incoming edges (${count}):`);
    graph.forEachIncomingEdge(node, (source, name) => {
      count++;
      if (count <= maxEdges) {
        const addr = source.address.toString(16);
        addInspectorLine(inspector, `0x${addr} ${source.name} ${name}`, 1, source);
      }
    });
    if (count > maxEdges) {
      addInspectorLine(inspector, `...skipped ${count - maxEdges} more...`, 1);
    }
  }
}

function addInspectorLine (inspector, text, indent, node) {
  if (indent) {
    for (let i = 0; i < indent; i++) {
      text = '&nbsp;&nbsp;' + text;
    }
  }
  const elem = document.createElement('p');
  if (node) {
    elem.onclick = () => selectNode(node);
  }

  elem.innerHTML = text;
  inspector.appendChild(elem);
}

function addInspectorButton (inspector, label, handler) {
  const input = document.createElement('input');
  input.type = 'button';
  input.value = label;
  input.onclick = handler;
  inspector.appendChild(input);
}

function selectNode (d) {
  if (!d.selected) {
    d.selected = true;
    display();
  }
  populateInspector(d);
}

function deselectNode (d) {
  d.selected = false;
  const related = getRelatedNodes(d, true, true);
  for (const id of related) {
    const node = graph.getNode(id);
    if (!hasSelectedRelatives(node)) {
      node.selected = false;
    }
  }
  display();
  closeInspector();
}

function hasSelectedRelatives (d) {
  const related = getRelatedNodes(d, true, true);
  for (const id of related) {
    const node = graph.getNode(id);
    if (node.selected) {
      return true;
    }
  }
  return false;
}

function selectRelatedNodes (d, hideOthers) {
  if (hideOthers) {
    for (const node of graph.nodes) {
      node.selected = false;
    }
  }
  d.selected = true;
  const related = getRelatedNodes(d, true, true);
  for (const id of related) {
    const node = graph.getNode(id);
    if (!node.selected) {
      node.selected = true;
      node.x = d.x;
      node.y = d.y;
    }
  }
  display();
}

async function selectRootsFromNode (node) {
  selectRoots([node], 0);
  display();
}

async function selectPathsBetween (a, b) {
  console.log(`Selecting paths between ${fullname(a)} and ${fullname(b)}`);
  selectPathBetween(a, b);
  selectPathBetween(b, a);
  display();
}

async function selectPathBetween (from, to) {
  selectPathWithBFS(from, node => node === to, () => undefined, 0);
}

async function selectGCPredecessor (from) {
  selectPathWithBFS(from, node => node.rc === -1, () => undefined, 0);
  display();
}

async function selectCCPredecessor (from) {
  selectPathWithBFS(from, node => node.rc !== -1, () => undefined, 0);
  display();
}

async function selectNodes () {
  setStatus('Selecting nodes');

  let count = 0;
  const selected = [];
  for (const d of graph.nodes) {
    d.root = d.incomingEdges.length === 0;
    d.filtered = false;
    d.selected = !config.filter || d.name.includes(config.filter);
    if (d.selected) {
      if (config.filter) {
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

async function selectRoots (selected, count) {
  for (const start of selected) {
    setStatus(`Searching for roots for ${fullname(start)}`);
    count += selectPathWithBFS(start,
      node => !graph.hasIncomingEdges(node),
      node => { node.root = true; },
      count);
    if (count === config.limit) {
      break;
    }
  }

  return count;
}

async function selectPathWithBFS (start, predicate, onFound, count) {
  // Perform a BFS from |start| searching for nodes for which
  // |predicate(node)| is true and select nodes along the path found.

  let i = 0;

  for (const node of graph.nodes) {
    node.visited = false;
  }

  const worklist = [{ node: start, path: null, length: 0 }];

  while (worklist.length) {
    let { node, path, length } = worklist.shift();

    if (node.visited) {
      continue;
    }
    node.visited = true;

    i++;
    if (i % 100000 === 0) {
      await poll(`Graph search: processed ${i} nodes`);
    }

    if (predicate(node)) {
      // Found a root, select nodes on its path.
      console.log(`  Found path of length ${length} from ${fullname(node)} to ${fullname(start)}`);
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
      // todo: add option to find all roots.
      return count;
    } else {
      // Queue unvisited incoming nodes.
      const newPath = { node, next: path };
      graph.forEachIncomingEdge(node, source => {
        if (!source.visited) {
          const item = { node: source, path: newPath, length: length + 1 };
          if (source.selected) {
            // Eager depth first traversal of previously found paths.
            worklist.unshift(item);
          } else {
            worklist.push(item);
          }
        }
      });
    }
  }

  console.log(`  Found no paths to ${fullname(start)}`);
  return count;
}

function selectRelated (selected, count) {
  const worklist = selected.map(node => ({ node, depth: 0 }));

  while (worklist.length) {
    const item = worklist.pop();
    const depth = item.depth + 1;
    if (depth > config.maxDepth) {
      continue;
    }

    const related = getRelatedNodes(item.node, config.incoming, config.outgoing);
    for (const node of related) {
      if (!node.selected) {
        node.selected = true;
        count++;
        if (count === config.limit) {
          return count;
        }
        worklist.push({ node, depth });
      }
    }
  }

  return count;
}

function getSelectedNodes () {
  const selected = [];
  for (const node of graph.nodes) {
    if (node.selected) {
      selected.push(node);
    }
  }
  return selected;
}

function getRelatedNodes (node, incoming, outgoing) {
  const related = [];
  if (incoming) {
    graph.forEachIncomingEdge(node, source => { related.push(source); });
  }
  if (outgoing) {
    graph.forEachOutgoingEdge(node, target => { related.push(target); });
  }
  return related;
}

function getLinks (graph, selected) {
  const links = [];
  for (const source of selected) {
    graph.forEachOutgoingEdge(source, (target, name) => {
      if (!config.allEdges) {
        // Skip edges from JS objects to global and prototype.
        if (name === 'baseshape_global' || name === 'baseshape_proto') {
          return;  // Continue loop.
        }
      }
      if (target.selected && !Object.is(source, target)) {
        links.push({ source: source.id,
                     target: target.id });
      }
    });
  }
  return links;
}
