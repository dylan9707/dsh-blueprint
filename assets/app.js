"use strict";

const token = new URLSearchParams(location.search).get("token") || "";
const state = {
  session: null,
  asIs: null,
  toBe: null,
  layout: null,
  continueCommand: "",
  diff: null,
  selectedNodeId: null,
  selectedEdgeId: null,
  connectSource: null,
  lastEdgeDragAt: 0,
  panelMode: "split",
  view: { asIs: { fit: true, zoom: 1 }, toBe: { fit: true, zoom: 1 } },
  dirty: false,
};

const $ = (selector) => document.querySelector(selector);
const nodeForm = $("#nodeForm");
const edgeForm = $("#edgeForm");
const inspector = $("#inspector");
const toast = $("#toast");
const MIN_NODE_WIDTH = 140;
const MIN_NODE_HEIGHT = 72;
const CHILD_GAP = 48;
const CHILD_INSET = 56;
const ROOT_INSET = 96;
const ROOT_GAP = 80;
const EDGE_LANE_GAP = 14;

async function api(path, options = {}) {
  const headers = { "X-Blueprint-Token": token, ...(options.headers || {}) };
  const response = await fetch("/plugins/blueprint" + path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function uid(prefix) { return `${prefix}-${crypto.randomUUID().slice(0, 8)}`; }
function nodeById(graph, id) { return graph.nodes.find((node) => node.id === id); }
function edgeById(graph, id) { return graph.edges.find((edge) => edge.id === id); }
const FINDING_SEVERITY_RANK = { info: 1, warning: 2, error: 3 };
function findingsFor(graph, pane, kind, id) {
  if (pane !== "asIs" || !Array.isArray(graph.findings)) return [];
  return graph.findings
    .filter((finding) => Array.isArray(finding.targets)
      && finding.targets.some((target) => target.kind === kind && target.id === id))
    .sort((left, right) => (FINDING_SEVERITY_RANK[right.severity] || 0) - (FINDING_SEVERITY_RANK[left.severity] || 0));
}
function findingClass(findings) {
  return findings.length ? ` finding-${findings[0].severity}` : "";
}
function findingBadgeText(findings) {
  if (!findings.length) return "";
  const primary = findings[0];
  const more = findings.length > 1 ? ` +${findings.length - 1}` : "";
  return `${primary.source.toUpperCase()} ${primary.severity.toUpperCase()}${more}`;
}
function findingTooltip(findings) {
  return findings.map((finding) => {
    const evidence = finding.evidence?.length
      ? `\nEvidence:\n${finding.evidence.map((item) => `  - ${item}`).join("\n")}`
      : "";
    return `[${finding.source.toUpperCase()} ${finding.severity.toUpperCase()}] ${finding.message}${evidence}`;
  }).join("\n\n");
}
function bindingText(node) {
  const binding = node.codeBinding;
  const parts = [binding.filename, binding.namespace, binding.process, binding.function].filter(Boolean);
  return parts.length ? parts.join(" · ") : "unbound";
}

function estimatedContentSize(node, isRoot = false) {
  const label = node.label || "Untitled block";
  const description = node.description || "";
  const baseWidth = isRoot ? 360 : 280;
  const maxWidth = isRoot ? 480 : 420;
  const minHeight = isRoot ? 178 : 112;
  const width = Math.min(maxWidth, Math.max(baseWidth, 150 + Math.min(label.length, 60) * 5));
  const labelChars = Math.max(18, Math.floor((width - 24) / 7));
  const descriptionChars = Math.max(24, Math.floor((width - 24) / 6));
  const labelLines = Math.max(1, Math.ceil(label.length / labelChars));
  const descriptionLines = description ? Math.min(3, Math.ceil(description.length / descriptionChars)) : 0;
  let contentHeight = 24 + 20 + 11 + 4 + labelLines * 20;
  if (descriptionLines) contentHeight += 5 + descriptionLines * 16;
  return { width, height: Math.max(minHeight, contentHeight), childTop: contentHeight + 14 };
}

function applyPosition(pane, nodeId) {
  const position = state.layout[pane].nodePositions[nodeId];
  const element = document.querySelector(`#${pane}Surface .graph-node[data-id="${CSS.escape(nodeId)}"]`);
  if (!position || !element) return;
  element.style.left = `${position.x}px`;
  element.style.top = `${position.y}px`;
  element.style.width = `${position.width}px`;
  element.style.height = `${position.height}px`;
}

function fitAncestors(nodeId, pane, graph) {
  let node = nodeById(graph, nodeId);
  while (node?.parentId) {
    const childPosition = state.layout[pane].nodePositions[node.id];
    const parent = nodeById(graph, node.parentId);
    const parentPosition = state.layout[pane].nodePositions[node.parentId];
    if (!childPosition || !parent || !parentPosition) break;
    const minimum = estimatedContentSize(parent, !parent.parentId);
    parentPosition.width = Math.max(parentPosition.width, minimum.width, childPosition.x + childPosition.width + CHILD_INSET);
    parentPosition.height = Math.max(parentPosition.height, minimum.height, childPosition.y + childPosition.height + CHILD_INSET);
    applyPosition(pane, parent.id);
    node = parent;
  }
}

function normalizeLayout(pane, graph) {
  const paneLayout = state.layout[pane];
  paneLayout.nodeColors ||= {};
  for (const id of Object.keys(paneLayout.nodeColors)) {
    if (!graph.nodes.some((node) => node.id === id)) delete paneLayout.nodeColors[id];
  }
  paneLayout.edgeAnchors ||= {};
  for (const id of Object.keys(paneLayout.edgeAnchors)) {
    if (!graph.edges.some((edge) => edge.id === id)) delete paneLayout.edgeAnchors[id];
  }
  if (!paneLayout.edgeRoutes || typeof paneLayout.edgeRoutes !== "object") paneLayout.edgeRoutes = {};
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  Object.keys(paneLayout.edgeRoutes).forEach((edgeId) => {
    if (!edgeIds.has(edgeId)) delete paneLayout.edgeRoutes[edgeId];
  });
  const positions = paneLayout.nodePositions;
  graph.nodes.forEach((node) => {
    const position = positions[node.id] || defaultPosition(node, pane);
    position.x = Math.max(position.x, 0);
    position.width = Math.max(position.width, MIN_NODE_WIDTH);
    position.height = Math.max(position.height, MIN_NODE_HEIGHT);
  });

  // Presets place new graphs; later edits must not repack saved coordinates.
  const fitSubtree = (nodeId) => {
    const node = nodeById(graph, nodeId);
    const position = positions[nodeId];
    if (!node || !position) return;
    graph.nodes.filter((child) => child.parentId === nodeId).forEach((child) => {
      fitSubtree(child.id);
      const childPosition = positions[child.id];
      position.width = Math.max(position.width, childPosition.x + childPosition.width + CHILD_INSET);
      position.height = Math.max(position.height, childPosition.y + childPosition.height + CHILD_INSET);
    });
  };
  graph.nodes.filter((node) => !node.parentId).forEach((node) => fitSubtree(node.id));
}

function defaultPosition(node, pane) {
  const positions = state.layout[pane].nodePositions;
  const siblings = (pane === "asIs" ? state.asIs : state.toBe).nodes.filter((item) => item.parentId === node.parentId);
  const previous = siblings
    .slice(0, Math.max(0, siblings.findIndex((item) => item.id === node.id)))
    .map((item) => positions[item.id])
    .filter(Boolean);
  const tiled = state.session?.viewProfile !== "execution-flow";
  if (tiled) {
    const parentNode = node.parentId ? nodeById(pane === "asIs" ? state.asIs : state.toBe, node.parentId) : null;
    const startX = node.parentId ? CHILD_INSET : ROOT_INSET;
    const startY = parentNode ? estimatedContentSize(parentNode, !parentNode.parentId).childTop : 48;
    const minimum = estimatedContentSize(node, !node.parentId);
    const x = previous.reduce((right, position) => Math.max(right, position.x + position.width + CHILD_GAP), startX);
    positions[node.id] = { x, y: startY, width: minimum.width, height: minimum.height };
    const parent = node.parentId ? positions[node.parentId] : null;
    if (parent) {
      parent.width = Math.max(parent.width, x + minimum.width + CHILD_INSET);
      parent.height = Math.max(parent.height, startY + minimum.height + CHILD_INSET);
    }
    return positions[node.id];
  }
  if (node.parentId) {
    const parentNode = nodeById(pane === "asIs" ? state.asIs : state.toBe, node.parentId);
    const startY = parentNode ? estimatedContentSize(parentNode, !parentNode.parentId).childTop : 112;
    const y = previous.reduce((bottom, position) => Math.max(bottom, position.y + position.height + CHILD_GAP), startY);
    const minimum = estimatedContentSize(node, false);
    positions[node.id] = { x: CHILD_INSET, y, width: minimum.width, height: minimum.height };
    const parent = positions[node.parentId];
    if (parent) {
      parent.width = Math.max(parent.width, positions[node.id].x + positions[node.id].width + CHILD_INSET);
      parent.height = Math.max(parent.height, positions[node.id].y + positions[node.id].height + CHILD_INSET);
    }
  } else {
    const y = previous.reduce((bottom, position) => Math.max(bottom, position.y + position.height + ROOT_GAP), 48);
    const minimum = estimatedContentSize(node, true);
    positions[node.id] = { x: ROOT_INSET, y, width: minimum.width, height: minimum.height };
  }
  return positions[node.id];
}

function setDirty(value = true) {
  state.dirty = value;
  $("#statusDot").classList.toggle("dirty", value);
  $("#statusText").textContent = value ? "Unsaved design changes" : "Saved locally";
  window.onbeforeunload = value ? () => true : null;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.style.borderColor = isError ? "#a34858" : "";
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function updateDiffSummary(diff = state.diff) {
  if (!diff) return;
  state.diff = diff;
  const s = diff.summary;
  $("#diffSummary").textContent = `Nodes +${s.nodesAdded} −${s.nodesRemoved} ~${s.nodesModified} · Edges +${s.edgesAdded} −${s.edgesRemoved} ~${s.edgesModified}`;
}

function descendants(graph, id) {
  const result = new Set();
  const visit = (parentId) => graph.nodes.filter((node) => node.parentId === parentId).forEach((node) => {
    result.add(node.id);
    visit(node.id);
  });
  visit(id);
  return result;
}

function makeNode(node, pane, graph, parentElement = null) {
  const pos = state.layout[pane].nodePositions[node.id] || defaultPosition(node, pane);
  const findings = findingsFor(graph, pane, "node", node.id);
  const element = document.createElement("div");
  element.className = `graph-node${node.parentId ? " nested" : ""}${state.selectedNodeId === node.id && pane === "toBe" ? " selected" : ""}${findingClass(findings)}`;
  element.dataset.id = node.id;
  element.dataset.nodeType = node.type;
  element.style.left = `${pos.x}px`;
  element.style.top = `${pos.y}px`;
  element.style.width = `${pos.width}px`;
  element.style.height = `${pos.height}px`;
  const customColor = state.layout[pane].nodeColors?.[node.id];
  if (customColor) {
    element.style.background = customColor;
    const rgb = customColor.match(/\w\w/g).map((value) => parseInt(value, 16));
    element.style.color = (rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114) < 140 ? "#ffffff" : "#20252c";
    element.classList.add("custom-color");
  }
  if (findings.length) element.title = findingTooltip(findings);

  const binding = document.createElement("div");
  binding.className = `node-binding ${node.codeBinding.status}`;
  binding.textContent = node.codeBinding.function || node.codeBinding.process || node.type;
  binding.title = bindingText(node);
  const color = document.createElement("input");
  color.type = "color";
  color.className = "node-color";
  color.value = customColor || "#ffffff";
  color.title = "Block color · double-click to restore preset";
  color.setAttribute("aria-label", `Color ${node.label}`);
  for (const name of ["pointerdown", "click"]) color.addEventListener(name, (e) => e.stopPropagation());
  color.addEventListener("change", () => {
    state.layout[pane].nodeColors ||= {};
    state.layout[pane].nodeColors[node.id] = color.value;
    setDirty(); renderPane(pane);
  });
  color.addEventListener("dblclick", (e) => {
    e.preventDefault(); e.stopPropagation();
    delete state.layout[pane].nodeColors[node.id];
    setDirty(); renderPane(pane);
  });
  binding.appendChild(color);
  const body = document.createElement("div");
  body.className = "node-body";
  body.innerHTML = `<div class="node-meta"><div class="node-type"></div></div><div class="node-label"></div><div class="node-description"></div>`;
  body.querySelector(".node-type").textContent = node.type;
  body.querySelector(".node-label").textContent = node.label;
  const description = body.querySelector(".node-description");
  description.textContent = node.description || "";
  description.title = node.description || "";
  if (findings.length) {
    const findingBadge = document.createElement("span");
    findingBadge.className = `node-finding-badge ${findings[0].severity}`;
    findingBadge.textContent = findingBadgeText(findings);
    findingBadge.title = findingTooltip(findings);
    body.querySelector(".node-meta").appendChild(findingBadge);
  }
  const children = graph.nodes.filter((candidate) => candidate.parentId === node.id);
  const childLayer = document.createElement("div");
  childLayer.className = "child-layer";
  if (children.length) {
    const childEdgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    childEdgeLayer.classList.add("child-edge-layer");
    childLayer.appendChild(childEdgeLayer);
  }
  const resizeHandle = document.createElement("button");
  resizeHandle.type = "button";
  resizeHandle.className = "resize-handle";
  resizeHandle.title = "Resize block";
  resizeHandle.setAttribute("aria-label", `Resize ${node.label}`);
  element.append(binding, body, childLayer, resizeHandle);

  if (children.length) element.classList.add("has-children");
  children.forEach((child) => makeNode(child, pane, graph, childLayer));

  element.addEventListener("click", (event) => {
    event.stopPropagation();
    if (pane !== "toBe") return;
    if (state.connectSource) {
      if (state.connectSource !== node.id) addEdge(state.connectSource, node.id);
      state.connectSource = null;
      $("#connectEdge").classList.remove("primary");
      return;
    }
    selectNode(node.id);
  });
  element.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    openNodeInspector(node.id, pane);
  });
  binding.addEventListener("pointerdown", (event) => startDrag(event, node.id, pane, element));
  resizeHandle.addEventListener("pointerdown", (event) => startResize(event, node.id, pane, element, resizeHandle));
  resizeHandle.addEventListener("click", (event) => event.stopPropagation());
  (parentElement || document.querySelector(`#${pane}Surface .node-layer`)).appendChild(element);
}

function startDrag(event, nodeId, pane, element) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const position = state.layout[pane].nodePositions[nodeId];
  const start = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
  element.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const zoom = state.view[pane].zoom;
    position.x = Math.max(0, Math.round(start.left + (moveEvent.clientX - start.x) / zoom));
    position.y = Math.max(0, Math.round(start.top + (moveEvent.clientY - start.y) / zoom));
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
    fitAncestors(nodeId, pane, pane === "asIs" ? state.asIs : state.toBe);
    renderEdges(pane);
    setDirty();
  };
  const up = () => {
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", up);
    renderPane(pane);
  };
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", up);
}

function startResize(event, nodeId, pane, element, handle) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const position = state.layout[pane].nodePositions[nodeId];
  const graph = pane === "asIs" ? state.asIs : state.toBe;
  const node = nodeById(graph, nodeId);
  const start = { x: event.clientX, y: event.clientY, width: position.width, height: position.height };
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const zoom = state.view[pane].zoom;
    const minimum = estimatedContentSize(node, !node.parentId);
    const childBounds = graph.nodes.filter((child) => child.parentId === nodeId).reduce((bounds, child) => {
      const childPosition = state.layout[pane].nodePositions[child.id];
      if (!childPosition) return bounds;
      return {
        width: Math.max(bounds.width, childPosition.x + childPosition.width + CHILD_INSET),
        height: Math.max(bounds.height, childPosition.y + childPosition.height + CHILD_INSET),
      };
    }, minimum);
    position.width = Math.max(MIN_NODE_WIDTH, childBounds.width, Math.round(start.width + (moveEvent.clientX - start.x) / zoom));
    position.height = Math.max(MIN_NODE_HEIGHT, childBounds.height, Math.round(start.height + (moveEvent.clientY - start.y) / zoom));
    element.style.width = `${position.width}px`;
    element.style.height = `${position.height}px`;
    fitAncestors(nodeId, pane, graph);
    renderEdges(pane);
    setDirty();
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    normalizeLayout(pane, graph);
    renderPane(pane);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function startEdgeRouteDrag(event, edgeId, pane, svg) {
  if (event.button !== 0) return;
  const start = { x: event.clientX, y: event.clientY };
  let moved = false;
  const move = (moveEvent) => {
    if (!moved && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 4) return;
    moved = true;
    moveEvent.preventDefault();
    const zoom = state.view[pane].zoom;
    const layerRect = svg.getBoundingClientRect();
    const layerWidth = layerRect.width / zoom;
    const x = Math.max(8, Math.min(layerWidth - 8, (moveEvent.clientX - layerRect.left) / zoom));
    const y = Math.max(8, Math.min(layerRect.height / zoom - 8, (moveEvent.clientY - layerRect.top) / zoom));
    state.layout[pane].edgeRoutes[edgeId] = { x: Math.round(x), y: Math.round(y) };
    setDirty();
    renderEdges(pane);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (moved) {
      state.lastEdgeDragAt = performance.now();
      renderPane(pane);
      showToast("Trace route adjusted · double-click to reset");
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function resetEdgeRoute(event, edgeId, pane) {
  event.preventDefault();
  event.stopPropagation();
  if (!state.layout[pane].edgeRoutes[edgeId]) return;
  delete state.layout[pane].edgeRoutes[edgeId];
  setDirty();
  renderEdges(pane);
  showToast("Automatic trace routing restored");
}

function startAnchorDrag(event, edge, end, pane, nodeElement) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY };
  let moved = false;
  const move = (e) => {
    if (e.pointerId !== event.pointerId) return;
    if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 3) return;
    moved = true;
    const box = nodeElement.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
    const y = Math.max(0, Math.min(1, (e.clientY - box.top) / box.height));
    const sides = [
      { side: "left", offset: y, distance: Math.abs(e.clientX - box.left) },
      { side: "right", offset: y, distance: Math.abs(e.clientX - box.right) },
      { side: "top", offset: x, distance: Math.abs(e.clientY - box.top) },
      { side: "bottom", offset: x, distance: Math.abs(e.clientY - box.bottom) },
    ];
    sides.sort((a, b) => a.distance - b.distance);
    const { side, offset } = sides[0];
    state.layout[pane].edgeAnchors ||= {};
    state.layout[pane].edgeAnchors[edge.id] ||= {};
    state.layout[pane].edgeAnchors[edge.id][end] = { side, offset };
    setDirty();
    renderEdges(pane);
  };
  const up = (e) => {
    if (e.pointerId !== event.pointerId) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (moved) { state.lastEdgeDragAt = performance.now(); renderPane(pane); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function renderEdges(pane) {
  const surface = $(`#${pane}Surface`);
  const rootSvg = surface.querySelector(".edge-layer");
  const graph = pane === "asIs" ? state.asIs : state.toBe;
  const zoom = state.view[pane].zoom;
  const layers = [rootSvg, ...surface.querySelectorAll(".child-edge-layer")];
  layers.forEach((layer) => layer.replaceChildren());
  const initializedLayers = new Set();
  const laneCounts = new Map();
  const siblingCache = new Map();
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const elementMap = new Map(
    [...surface.querySelectorAll(".graph-node")].map((element) => [element.dataset.id, element]),
  );
  const pairCounts = graph.edges.reduce((counts, edge) => {
    const pair = `${edge.source}\u0000${edge.target}`;
    counts.set(pair, (counts.get(pair) || 0) + 1);
    return counts;
  }, new Map());
  const seenPairs = new Map();

  const siblings = (parentId) => {
    const key = parentId || "__root__";
    if (!siblingCache.has(key)) siblingCache.set(key, graph.nodes.filter((node) => node.parentId === parentId));
    return siblingCache.get(key);
  };

  const topAncestor = (node) => {
    let current = node;
    while (current?.parentId) current = nodeMap.get(current.parentId);
    return current;
  };

  const takeLane = (svg, side) => {
    if (!laneCounts.has(svg)) laneCounts.set(svg, { left: 0, right: 0 });
    const counts = laneCounts.get(svg);
    const lane = counts[side];
    counts[side] += 1;
    return lane;
  };

  const edgeLayer = (edge) => {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (!sourceNode?.parentId || sourceNode.parentId !== targetNode?.parentId) return { svg: rootSvg, key: "root" };
    const parent = elementMap.get(sourceNode.parentId);
    const svg = parent?.querySelector(":scope > .child-layer > .child-edge-layer");
    return { svg: svg || rootSvg, key: svg ? sourceNode.parentId : "root" };
  };

  const markerFor = (svg, key) => {
    const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, "-");
    const markerId = `arrow-${pane}-${safeKey}`;
    if (!initializedLayers.has(svg)) {
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.innerHTML = `<marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path></marker>`;
      svg.appendChild(defs);
      initializedLayers.add(svg);
    }
    return markerId;
  };

  graph.edges.forEach((edge) => {
    const source = elementMap.get(edge.source);
    const target = elementMap.get(edge.target);
    if (!source || !target) return;
    const { svg, key } = edgeLayer(edge);
    const layerRect = svg.getBoundingClientRect();
    const markerId = markerFor(svg, key);
    const findings = findingsFor(graph, pane, "edge", edge.id);
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    const a = source.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const aLeft = (a.left - layerRect.left) / zoom;
    const aRight = (a.right - layerRect.left) / zoom;
    const aTop = (a.top - layerRect.top) / zoom;
    const aBottom = (a.bottom - layerRect.top) / zoom;
    const bLeft = (b.left - layerRect.left) / zoom;
    const bRight = (b.right - layerRect.left) / zoom;
    const bTop = (b.top - layerRect.top) / zoom;
    const bBottom = (b.bottom - layerRect.top) / zoom;
    const aCenterX = (aLeft + aRight) / 2;
    const aCenterY = (aTop + aBottom) / 2;
    const bCenterX = (bLeft + bRight) / 2;
    const bCenterY = (bTop + bBottom) / 2;
    const vertical = Math.abs(bCenterY - aCenterY) >= Math.abs(bCenterX - aCenterX);
    const sameParent = sourceNode?.parentId === targetNode?.parentId;
    const peerNodes = sameParent ? siblings(sourceNode.parentId) : [];
    const sourceIndex = peerNodes.findIndex((node) => node.id === edge.source);
    const targetIndex = peerNodes.findIndex((node) => node.id === edge.target);
    const span = sourceIndex >= 0 && targetIndex >= 0 ? Math.abs(targetIndex - sourceIndex) : Number.POSITIVE_INFINITY;
    const parallel = pairCounts.get(`${edge.source}\u0000${edge.target}`) > 1;
    const manualRoute = state.layout[pane].edgeRoutes[edge.id];
    const sideRouted = Boolean(manualRoute) || !sameParent || span > 1 || parallel;
    const profile = state.session?.viewProfile || "execution-flow";
    const pairKey = `${edge.source}\u0000${edge.target}`;
    const pairIndex = seenPairs.get(pairKey) || 0;
    seenPairs.set(pairKey, pairIndex + 1);
    let x1;
    let y1;
    let x2;
    let y2;
    let d;
    let labelX;
    let labelY;
    let routeKind = "direct";
    let routeSide = "center";
    if (!manualRoute && profile === "component-architecture") {
      routeKind = "orthogonal";
      const pairOffset = (pairIndex - ((pairCounts.get(pairKey) || 1) - 1) / 2) * EDGE_LANE_GAP;
      if (Math.abs(bCenterX - aCenterX) >= Math.abs(bCenterY - aCenterY)) {
        const direction = bCenterX >= aCenterX ? 1 : -1;
        x1 = direction > 0 ? aRight : aLeft;
        y1 = aCenterY;
        x2 = direction > 0 ? bLeft : bRight;
        y2 = bCenterY;
        const middleX = (x1 + x2) / 2 + pairOffset;
        d = `M ${x1} ${y1} L ${middleX} ${y1} L ${middleX} ${y2} L ${x2} ${y2}`;
        labelX = middleX;
        labelY = (y1 + y2) / 2;
      } else {
        const direction = bCenterY >= aCenterY ? 1 : -1;
        x1 = aCenterX;
        y1 = direction > 0 ? aBottom : aTop;
        x2 = bCenterX;
        y2 = direction > 0 ? bTop : bBottom;
        const middleY = (y1 + y2) / 2 + pairOffset;
        d = `M ${x1} ${y1} L ${x1} ${middleY} L ${x2} ${middleY} L ${x2} ${y2}`;
        labelX = (x1 + x2) / 2;
        labelY = middleY;
      }
    } else if (!manualRoute && profile === "state-workflow") {
      routeKind = "transition";
      const reversePair = pairCounts.has(`${edge.target}\u0000${edge.source}`);
      const parallelCount = pairCounts.get(pairKey) || 1;
      const parallelArc = (pairIndex - (parallelCount - 1) / 2) * EDGE_LANE_GAP;
      const reverseArc = reversePair ? (edge.source < edge.target ? -36 : 36) : 0;
      const arc = reverseArc + parallelArc;
      if (Math.abs(bCenterX - aCenterX) >= Math.abs(bCenterY - aCenterY)) {
        const direction = bCenterX >= aCenterX ? 1 : -1;
        x1 = direction > 0 ? aRight : aLeft;
        y1 = aCenterY;
        x2 = direction > 0 ? bLeft : bRight;
        y2 = bCenterY;
        const curve = Math.min(120, Math.max(32, Math.abs(x2 - x1) * .4));
        d = `M ${x1} ${y1} C ${x1 + direction * curve} ${y1 + arc}, ${x2 - direction * curve} ${y2 + arc}, ${x2} ${y2}`;
        labelX = (x1 + x2) / 2;
        labelY = (y1 + y2) / 2 + arc * .75;
      } else {
        const direction = bCenterY >= aCenterY ? 1 : -1;
        x1 = aCenterX;
        y1 = direction > 0 ? aBottom : aTop;
        x2 = bCenterX;
        y2 = direction > 0 ? bTop : bBottom;
        const curve = Math.min(120, Math.max(32, Math.abs(y2 - y1) * .4));
        d = `M ${x1} ${y1} C ${x1 + arc} ${y1 + direction * curve}, ${x2 + arc} ${y2 - direction * curve}, ${x2} ${y2}`;
        labelX = (x1 + x2) / 2 + arc * .75;
        labelY = (y1 + y2) / 2;
      }
    } else if (sideRouted) {
      routeKind = manualRoute ? "manual" : "lane";
      const backward = sameParent && sourceIndex >= 0 && targetIndex >= 0 && sourceIndex > targetIndex;
      const side = manualRoute
        ? (manualRoute.x < (aCenterX + bCenterX) / 2 ? "left" : "right")
        : (["control", "dependency"].includes(edge.type) || backward ? "left" : "right");
      routeSide = side;
      const lane = manualRoute ? 0 : takeLane(svg, side);
      const direction = bCenterY >= aCenterY ? 1 : -1;
      x1 = side === "right" ? aRight : aLeft;
      x2 = side === "right" ? bRight : bLeft;
      y1 = aCenterY;
      y2 = bCenterY;
      let boundary;
      if (key === "root") {
        const sourceRoot = elementMap.get(topAncestor(sourceNode).id).getBoundingClientRect();
        const targetRoot = elementMap.get(topAncestor(targetNode).id).getBoundingClientRect();
        boundary = side === "right"
          ? (Math.max(sourceRoot.right, targetRoot.right) - layerRect.left) / zoom
          : (Math.min(sourceRoot.left, targetRoot.left) - layerRect.left) / zoom;
      } else {
        boundary = side === "right" ? Math.max(aRight, bRight) : Math.min(aLeft, bLeft);
      }
      const offset = 18 + lane * EDGE_LANE_GAP;
      const layerWidth = layerRect.width / zoom;
      const autoLaneX = side === "right"
        ? Math.min(layerWidth - 8, boundary + offset)
        : Math.max(8, boundary - offset);
      const laneX = manualRoute
        ? (side === "right"
            ? Math.min(layerWidth - 8, Math.max(boundary + 8, manualRoute.x))
            : Math.max(8, Math.min(boundary - 8, manualRoute.x)))
        : autoLaneX;
      const bend = Math.min(18, Math.max(4, Math.abs(y2 - y1) / 4));
      d = `M ${x1} ${y1} C ${(x1 + laneX) / 2} ${y1}, ${laneX} ${y1}, ${laneX} ${y1 + direction * bend} L ${laneX} ${y2 - direction * bend} C ${laneX} ${y2}, ${(x2 + laneX) / 2} ${y2}, ${x2} ${y2}`;
      labelX = laneX;
      labelY = y2;
    } else if (vertical) {
      const direction = bCenterY >= aCenterY ? 1 : -1;
      x1 = aCenterX;
      y1 = direction > 0 ? aBottom : aTop;
      x2 = bCenterX;
      y2 = direction > 0 ? bTop : bBottom;
      const curve = Math.min(60, Math.max(18, Math.abs(y2 - y1) * .45));
      d = `M ${x1} ${y1} C ${x1} ${y1 + direction * curve}, ${x2} ${y2 - direction * curve}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = (y1 + y2) / 2;
    } else {
      const direction = bCenterX >= aCenterX ? 1 : -1;
      x1 = direction > 0 ? aRight : aLeft;
      y1 = aCenterY;
      x2 = direction > 0 ? bLeft : bRight;
      y2 = bCenterY;
      const curve = Math.min(60, Math.max(18, Math.abs(x2 - x1) * .45));
      d = `M ${x1} ${y1} C ${x1 + direction * curve} ${y1}, ${x2 - direction * curve} ${y2}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = (y1 + y2) / 2;
    }
    const anchors = state.layout[pane].edgeAnchors?.[edge.id] || {};
    const anchorPoint = (anchor, left, top, right, bottom, x, y) => {
      const side = anchor?.side || (Math.abs(x - left) < .1 ? "left" : Math.abs(x - right) < .1 ? "right" : Math.abs(y - top) < .1 ? "top" : "bottom");
      if (anchor) {
        x = side === "left" ? left : side === "right" ? right : left + (right - left) * anchor.offset;
        y = side === "top" ? top : side === "bottom" ? bottom : top + (bottom - top) * anchor.offset;
      }
      return { x, y, dx: side === "left" ? -1 : side === "right" ? 1 : 0,
        dy: side === "top" ? -1 : side === "bottom" ? 1 : 0 };
    };
    const from = anchorPoint(anchors.source, aLeft, aTop, aRight, aBottom, x1, y1);
    const to = anchorPoint(anchors.target, bLeft, bTop, bRight, bBottom, x2, y2);
    if (anchors.source || anchors.target) {
      const reach = Math.min(120, Math.max(32, Math.hypot(to.x - from.x, to.y - from.y) / 3));
      const sx = from.x + from.dx * reach, sy = from.y + from.dy * reach;
      const tx = to.x + to.dx * reach, ty = to.y + to.dy * reach;
      d = manualRoute
        ? `M ${from.x} ${from.y} L ${sx} ${sy} L ${manualRoute.x} ${sy} L ${manualRoute.x} ${ty} L ${tx} ${ty} L ${to.x} ${to.y}`
        : profile === "component-architecture"
          ? `M ${from.x} ${from.y} L ${sx} ${sy} L ${sx} ${ty} L ${tx} ${ty} L ${to.x} ${to.y}`
          : `M ${from.x} ${from.y} C ${sx} ${sy}, ${tx} ${ty}, ${to.x} ${to.y}`;
      labelX = manualRoute ? manualRoute.x : (sx + tx) / 2;
      labelY = manualRoute ? (sy + ty) / 2 : profile === "component-architecture" ? ty : (from.y + to.y) / 2;
      if (!manualRoute && profile === "component-architecture" && from.dx && from.dx === to.dx) {
        const lane = from.dx > 0 ? Math.max(aRight, bRight) + reach : Math.min(aLeft, bLeft) - reach;
        d = `M ${from.x} ${from.y} L ${lane} ${from.y} L ${lane} ${to.y} L ${to.x} ${to.y}`;
        labelX = lane; labelY = (from.y + to.y) / 2;
      } else if (!manualRoute && profile === "component-architecture" && from.dy && from.dy === to.dy) {
        const lane = from.dy > 0 ? Math.max(aBottom, bBottom) + reach : Math.min(aTop, bTop) - reach;
        d = `M ${from.x} ${from.y} L ${from.x} ${lane} L ${to.x} ${lane} L ${to.x} ${to.y}`;
        labelX = (from.x + to.x) / 2; labelY = lane;
      }
    }
    if (manualRoute && Number.isFinite(manualRoute.y)) {
      const sx = from.x + from.dx * 24, sy = from.y + from.dy * 24;
      const tx = to.x + to.dx * 24, ty = to.y + to.dy * 24;
      d = `M ${from.x} ${from.y} L ${sx} ${sy} L ${manualRoute.x} ${sy} L ${manualRoute.x} ${manualRoute.y} L ${tx} ${manualRoute.y} L ${tx} ${ty} L ${to.x} ${to.y}`;
      labelX = manualRoute.x; labelY = manualRoute.y;
      routeKind = "manual";
    }
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", `edge-group type-${edge.type}${findingClass(findings)}`);
    group.dataset.edgeId = edge.id;
    group.dataset.route = routeKind;
    group.dataset.side = routeSide;
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    const interactionTitle = `Drag in any direction to reroute · double-click to reset · ${edge.type}: ${edge.label || edge.description || edge.id}`;
    title.textContent = findings.length ? `${findingTooltip(findings)}\n\n${interactionTitle}` : interactionTitle;
    const visible = document.createElementNS("http://www.w3.org/2000/svg", "path");
    visible.setAttribute("d", d);
    visible.setAttribute("marker-end", `url(#${markerId})`);
    visible.setAttribute("class", `edge-visible type-${edge.type}${pane === "toBe" && state.selectedEdgeId === edge.id ? " edge-selected" : ""}`);
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "edge-hit");
    hit.addEventListener("pointerdown", (event) => startEdgeRouteDrag(event, edge.id, pane, svg));
    hit.addEventListener("dblclick", (event) => resetEdgeRoute(event, edge.id, pane));
    if (pane === "toBe") hit.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.lastEdgeDragAt && performance.now() - state.lastEdgeDragAt < 250) return;
      selectEdge(edge.id);
    });
    group.append(title, visible, hit);
    const fullLabel = `${edge.type.toUpperCase()}${edge.label ? ` · ${edge.label}` : ""}`;
    const abbreviations = { control: "CTRL", dependency: "DEP", signal: "SIG", data: "DATA", call: "CALL", sequence: "SEQ", pipeline: "PIPE" };
    const laneRouted = ["lane", "manual"].includes(routeKind);
    const showLanePayload = laneRouted && ["signal", "data"].includes(edge.type) && Boolean(edge.label);
    const labelLimit = showLanePayload ? 80 : 34;
    const displayLabel = laneRouted && !showLanePayload
      ? (abbreviations[edge.type] || edge.type.toUpperCase().slice(0, 5))
      : (fullLabel.length > labelLimit ? `${fullLabel.slice(0, labelLimit - 1)}…` : fullLabel);
    const maxLabelWidth = showLanePayload ? 480 : 240;
    const labelWidth = laneRouted && !showLanePayload ? 44 : Math.max(48, Math.min(maxLabelWidth, displayLabel.length * 5.8 + 16));
    const labelAnchor = "middle";
    const textX = labelX;
    const backgroundX = labelX - labelWidth / 2;
    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("x", String(backgroundX));
    background.setAttribute("y", String(labelY - 11));
    background.setAttribute("width", String(labelWidth));
    background.setAttribute("height", "20");
    background.setAttribute("rx", "8");
    background.setAttribute("class", `edge-label-bg type-${edge.type}`);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(textX));
    label.setAttribute("y", String(labelY + 3));
    label.setAttribute("text-anchor", labelAnchor);
    label.setAttribute("class", "edge-label");
    label.textContent = displayLabel;
    group.append(background, label);
    for (const [end, point, nodeId] of [["source", from, edge.source], ["target", to, edge.target]]) {
      const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      handle.setAttribute("class", "edge-anchor");
      handle.dataset.end = end;
      handle.setAttribute("cx", point.x);
      handle.setAttribute("cy", point.y);
      handle.setAttribute("r", String(4 / zoom));
      const hint = document.createElementNS("http://www.w3.org/2000/svg", "title");
      hint.textContent = `Drag ${end} along block border · double-click to reset`;
      handle.appendChild(hint);
      handle.addEventListener("pointerdown", (event) => startAnchorDrag(event, edge, end, pane, elementMap.get(nodeId)));
      handle.addEventListener("click", (event) => event.stopPropagation());
      handle.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        const saved = state.layout[pane].edgeAnchors?.[edge.id];
        if (!saved?.[end]) return;
        delete saved[end];
        if (!Object.keys(saved).length) delete state.layout[pane].edgeAnchors[edge.id];
        setDirty(); renderPane(pane);
      });
      group.appendChild(handle);
    }
    svg.appendChild(group);
  });
}

function renderPane(pane) {
  const surface = $(`#${pane}Surface`);
  const graph = pane === "asIs" ? state.asIs : state.toBe;
  surface.dataset.profile = state.session?.viewProfile || "execution-flow";
  const view = state.view[pane];
  const viewport = surface.parentElement;
  const rootBounds = graph.nodes
    .filter((node) => !node.parentId)
    .map((node) => state.layout[pane].nodePositions[node.id] || defaultPosition(node, pane));
  const contentWidth = rootBounds.reduce((extent, position) => Math.max(extent, position.x + position.width + 80), 320);
  const contentHeight = rootBounds.reduce((extent, position) => Math.max(extent, position.y + position.height + 120), 240);
  if (view.fit && viewport.clientWidth && viewport.clientHeight) {
    view.zoom = Math.min(1, Math.max(1, viewport.clientWidth - 32) / contentWidth,
      Math.max(1, viewport.clientHeight - 32) / contentHeight);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }
  const zoom = view.zoom;
  surface.style.width = `${contentWidth}px`;
  surface.style.height = `${contentHeight}px`;
  // CSS zoom scales layout extents too, avoiding unscaled scrollbars after Fit.
  surface.style.zoom = String(zoom);
  surface.style.marginLeft = "auto";
  surface.style.marginTop = "0px";
  viewport.style.overflow = view.fit ? "hidden" : "auto";
  surface.querySelector(".node-layer").replaceChildren();
  graph.nodes.filter((node) => !node.parentId).forEach((node) => makeNode(node, pane, graph));
  requestAnimationFrame(() => {
    renderEdges(pane);
    if (!view.fit || !viewport.clientWidth || !viewport.clientHeight) return;
    // Include labels and manual routes, which can extend outside root node bounds.
    const origin = surface.getBoundingClientRect();
    const scale = view.zoom;
    let left = 0, top = 0, right = contentWidth, bottom = contentHeight;
    surface.querySelectorAll(".graph-node, .edge-group").forEach((element) => {
      const rect = element.getBoundingClientRect();
      left = Math.min(left, (rect.left - origin.left) / scale);
      top = Math.min(top, (rect.top - origin.top) / scale);
      right = Math.max(right, (rect.right - origin.left) / scale);
      bottom = Math.max(bottom, (rect.bottom - origin.top) / scale);
    });
    view.zoom = Math.min(1, Math.max(1, viewport.clientWidth - 32) / (right - left),
      Math.max(1, viewport.clientHeight - 32) / (bottom - top));
    surface.style.zoom = String(view.zoom);
    surface.style.marginLeft = `${((viewport.clientWidth / view.zoom - (right - left)) / 2) - left}px`;
    surface.style.marginTop = `${16 / view.zoom - top}px`;
    $(`#${pane}Zoom`).textContent = `${Math.round(view.zoom * 100)}%`;
  });
  $(`#${pane}Zoom`).textContent = `${Math.round(zoom * 100)}%`;
}

function renderAll() {
  renderPane("asIs");
  renderPane("toBe");
  $("#deleteItem").disabled = !state.selectedNodeId && !state.selectedEdgeId;
}

function togglePanelMode(pane) {
  state.panelMode = state.panelMode === pane ? "split" : pane;
  const workspace = $("#workspace");
  workspace.dataset.panelMode = state.panelMode;
  document.querySelectorAll("[data-pane-shell]").forEach((element) => {
    const paneName = element.dataset.paneShell;
    const collapsed = state.panelMode !== "split" && state.panelMode !== paneName;
    const expanded = state.panelMode === paneName;
    element.classList.toggle("is-collapsed", collapsed);
    element.classList.toggle("is-expanded", expanded);
  });
  document.querySelectorAll("[data-panel-toggle]").forEach((button) => {
    const paneName = button.dataset.panelToggle;
    button.textContent = state.panelMode === "split" ? "Expand" : (state.panelMode === paneName ? "Split" : "Open");
    button.setAttribute("aria-pressed", String(state.panelMode === paneName));
  });
  requestAnimationFrame(() => {
    for (const name of ["asIs", "toBe"]) {
      state.view[name].fit = true;
      if (state.panelMode === "split" || state.panelMode === name) renderPane(name);
    }
  });
}

function selectNode(id) {
  state.selectedNodeId = id;
  state.selectedEdgeId = null;
  renderPane("toBe");
  $("#deleteItem").disabled = false;
}

function selectEdge(id) {
  state.selectedNodeId = null;
  state.selectedEdgeId = id;
  renderPane("toBe");
  $("#deleteItem").disabled = false;
  openEdgeInspector(id);
}

function openInspector(kind) {
  inspector.classList.add("open");
  inspector.setAttribute("aria-hidden", "false");
  nodeForm.hidden = kind !== "node";
  edgeForm.hidden = kind !== "edge";
}

function closeInspector() {
  inspector.classList.remove("open");
  inspector.setAttribute("aria-hidden", "true");
}

function openNodeInspector(id, pane = "toBe") {
  state.inspectorPane = pane;
  if (pane === "toBe") selectNode(id);
  else {
    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    state.connectSource = null;
    $("#deleteItem").disabled = true;
    $("#connectEdge").classList.remove("primary");
    renderPane("toBe");
  }
  const graph = pane === "toBe" ? state.toBe : state.asIs;
  const node = nodeById(graph, id);
  if (!node) return;
  $("#inspectorTitle").textContent = "Block";
  const blocked = descendants(graph, id);
  blocked.add(id);
  const parent = nodeForm.elements.parentId;
  parent.replaceChildren(new Option("Top level", ""));
  graph.nodes.filter((candidate) => !blocked.has(candidate.id)).forEach((candidate) => parent.add(new Option(candidate.label, candidate.id)));
  const position = state.layout[pane].nodePositions[id] || defaultPosition(node, pane);
  const values = {
    label: node.label, type: node.type, description: node.description, parentId: node.parentId || "",
    filename: node.codeBinding.filename, namespace: node.codeBinding.namespace,
    process: node.codeBinding.process, function: node.codeBinding.function,
    bindingStatus: node.codeBinding.status, bindingSource: node.codeBinding.source,
    width: position.width, height: position.height,
  };
  Object.entries(values).forEach(([name, value]) => { nodeForm.elements[name].value = value; });
  [...nodeForm.elements].forEach((control) => { control.disabled = pane === "asIs"; });
  openInspector("node");
}

function openEdgeInspector(id) {
  const edge = edgeById(state.toBe, id);
  if (!edge) return;
  $("#inspectorTitle").textContent = "Connection";
  for (const name of ["source", "target"]) {
    const select = edgeForm.elements[name];
    select.replaceChildren();
    state.toBe.nodes.forEach((node) => select.add(new Option(node.label, node.id)));
  }
  for (const name of ["label", "type", "description", "source", "target"]) edgeForm.elements[name].value = edge[name];
  openInspector("edge");
}

function addNode() {
  const node = {
    id: uid("node"), type: "function", label: "New block", description: "", parentId: null,
    codeBinding: { filename: "", namespace: "", process: "", function: "", status: "unbound", source: "none" },
  };
  state.toBe.nodes.push(node);
  defaultPosition(node, "toBe");
  setDirty();
  renderAll();
  openNodeInspector(node.id);
  nodeForm.elements.label.select();
}

function addEdge(source, target) {
  const edge = { id: uid("edge"), source, target, type: "flow", label: "", description: "" };
  state.toBe.edges.push(edge);
  setDirty();
  selectEdge(edge.id);
}

function deleteSelection() {
  if (state.selectedNodeId) {
    const ids = descendants(state.toBe, state.selectedNodeId);
    ids.add(state.selectedNodeId);
    state.toBe.nodes = state.toBe.nodes.filter((node) => !ids.has(node.id));
    state.toBe.edges = state.toBe.edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
    ids.forEach((id) => delete state.layout.toBe.nodePositions[id]);
    state.selectedNodeId = null;
  } else if (state.selectedEdgeId) {
    state.toBe.edges = state.toBe.edges.filter((edge) => edge.id !== state.selectedEdgeId);
    delete state.layout.toBe.edgeRoutes[state.selectedEdgeId];
    state.selectedEdgeId = null;
  }
  closeInspector();
  setDirty();
  renderAll();
}

function syncNodeForm() {
  if (state.inspectorPane === "asIs") return;
  const node = nodeById(state.toBe, state.selectedNodeId);
  if (!node) return;
  const previousParent = node.parentId;
  node.label = nodeForm.elements.label.value.trim() || "Untitled block";
  node.type = nodeForm.elements.type.value.trim() || "block";
  node.description = nodeForm.elements.description.value;
  node.parentId = nodeForm.elements.parentId.value || null;
  for (const key of ["filename", "namespace", "process", "function"]) node.codeBinding[key] = nodeForm.elements[key].value;
  node.codeBinding.status = nodeForm.elements.bindingStatus.value;
  node.codeBinding.source = nodeForm.elements.bindingSource.value;
  const bindingWasEdited = ["filename", "namespace", "process", "function"].some((key) => document.activeElement === nodeForm.elements[key]);
  if (bindingWasEdited) {
    node.codeBinding.source = "user";
    if (Object.values(node.codeBinding).slice(0, 4).some(Boolean) && node.codeBinding.status === "unbound") node.codeBinding.status = "confirmed";
    nodeForm.elements.bindingSource.value = node.codeBinding.source;
    nodeForm.elements.bindingStatus.value = node.codeBinding.status;
  }
  const position = state.layout.toBe.nodePositions[node.id];
  const minimum = estimatedContentSize(node, !node.parentId);
  position.width = Math.max(MIN_NODE_WIDTH, Number(nodeForm.elements.width.value) || position.width);
  position.height = Math.max(MIN_NODE_HEIGHT, Number(nodeForm.elements.height.value) || position.height);
  if (previousParent !== node.parentId) {
    position.x = node.parentId ? CHILD_INSET : ROOT_INSET;
    const parent = node.parentId ? nodeById(state.toBe, node.parentId) : null;
    position.y = parent ? estimatedContentSize(parent, !parent.parentId).childTop : 50;
  }
  normalizeLayout("toBe", state.toBe);
  nodeForm.elements.width.value = position.width;
  nodeForm.elements.height.value = position.height;
  setDirty();
  renderPane("toBe");
}

function syncEdgeForm() {
  const edge = edgeById(state.toBe, state.selectedEdgeId);
  if (!edge) return;
  for (const name of ["label", "type", "description", "source", "target"]) edge[name] = edgeForm.elements[name].value;
  setDirty();
  renderPane("toBe");
}

async function save(handoff = false) {
  try {
    const result = await api(handoff ? "/api/handoff" : "/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toBe: state.toBe, layout: state.layout }),
    });
    setDirty(false);
    updateDiffSummary(result.diff);
    if (handoff) showHandoff(result);
    else showToast("Saved locally");
  } catch (error) {
    $("#statusDot").classList.add("error");
    $("#statusText").textContent = error.message;
    showToast(error.message, true);
  }
}

function showHandoff(result) {
  $("#continueCommand").textContent = result.handoff.continueCommand || state.continueCommand;
  const s = result.diff.summary;
  $("#handoffSummary").textContent = `Semantic changes: ${s.nodesAdded} nodes added, ${s.nodesRemoved} removed, ${s.nodesModified} modified; ${s.edgesAdded} edges added, ${s.edgesRemoved} removed, ${s.edgesModified} modified.`;
  $("#handoffDialog").showModal();
}

function wireEvents() {
  $("#addNode").addEventListener("click", addNode);
  $("#deleteItem").addEventListener("click", deleteSelection);
  $("#save").addEventListener("click", () => save(false));
  $("#updateAgent").addEventListener("click", () => save(true));
  $("#connectEdge").addEventListener("click", () => {
    state.connectSource = state.selectedNodeId;
    $("#connectEdge").classList.toggle("primary", Boolean(state.connectSource));
    showToast(state.connectSource ? "Select a target block" : "Select a source block first");
  });
  $("#closeInspector").addEventListener("click", closeInspector);
  nodeForm.addEventListener("input", syncNodeForm);
  nodeForm.addEventListener("change", syncNodeForm);
  edgeForm.addEventListener("input", syncEdgeForm);
  edgeForm.addEventListener("change", syncEdgeForm);
  document.querySelectorAll(".surface").forEach((surface) => surface.addEventListener("click", () => {
    if (surface.dataset.pane === "toBe") {
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      state.connectSource = null;
      $("#connectEdge").classList.remove("primary");
      closeInspector();
      renderPane("toBe");
    }
  }));
  document.querySelectorAll("[data-zoom]").forEach((button) => button.addEventListener("click", () => {
    const pane = button.dataset.zoom;
    state.view[pane].fit = false;
    state.view[pane].zoom = Math.min(2, Math.max(.01, state.view[pane].zoom * (Number(button.dataset.delta) > 0 ? 1.25 : .8)));
    renderPane(pane);
  }));
  document.querySelectorAll("[data-fit]").forEach((button) => button.addEventListener("click", () => {
    state.view[button.dataset.fit].fit = true;
    renderPane(button.dataset.fit);
  }));
  document.querySelectorAll("[data-panel-toggle]").forEach((button) => button.addEventListener("click", () => {
    togglePanelMode(button.dataset.panelToggle);
  }));
  $("#copyCommand").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#continueCommand").textContent);
    showToast("Continue command copied");
  });
  $("#closeDialog").addEventListener("click", () => $("#handoffDialog").close());
  window.addEventListener("resize", () => {
    for (const pane of ["asIs", "toBe"]) {
      state.view[pane].fit = true;
      if (state.panelMode === "split" || state.panelMode === pane) renderPane(pane);
    }
  });
}

async function init() {
  try {
    const payload = await api("/api/session");
    Object.assign(state, payload);
    normalizeLayout("asIs", state.asIs);
    normalizeLayout("toBe", state.toBe);
    $("#sessionMeta").textContent = `${payload.session.scope} · ${payload.session.viewProfile} · ${payload.session.sessionId}`;
    updateDiffSummary(payload.diff);
    setDirty(false);
    wireEvents();
    renderAll();
  } catch (error) {
    $("#statusDot").classList.add("error");
    $("#statusText").textContent = error.message;
  }
}

init();
