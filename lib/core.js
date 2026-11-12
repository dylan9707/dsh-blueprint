// Blueprint session core — JavaScript port of
// D:\InfMed\InfMedSoftware\AgentTools\blueprint\scripts\blueprint.py (session,
// validation, semantic diff). Preset layout is intentionally not ported: the
// browser's profile-aware `defaultPosition()` lays out an empty layout.
// Sessions live in <workspace>/.blueprint/ (a workspace-relative store so the
// agent can read/write the same design the panel shows).
import { readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const VIEW_PROFILES = ['execution-flow', 'component-architecture', 'state-workflow'];
export const BINDING_STATUS = new Set(['unbound', 'proposed', 'confirmed']);
export const BINDING_SOURCE = new Set(['none', 'agent', 'user']);
export const FINDING_SEVERITY = new Set(['error', 'warning', 'info']);
export const FINDING_SOURCE = new Set(['agent']);
export const FINDING_TARGET_KIND = new Set(['node', 'edge']);
export const SHAPES = ['rect', 'rounded', 'ellipse', 'diamond', 'hexagon'];
export const SESSION_FILES = ['session.json', 'as-is.json', 'to-be.json', 'layout.json', 'handoff.json'];

export class BlueprintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlueprintError';
  }
}

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function slugify(value, fallback = 'blueprint') {
  const slug = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (slug || fallback).slice(0, 72);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new BlueprintError('Missing file: ' + path);
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new BlueprintError('Invalid JSON in ' + path + ': ' + error.message);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new BlueprintError('Expected a JSON object in ' + path);
  }
  return data;
}

export async function atomicWriteJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  const temp = path + '.tmp';
  await writeFile(temp, text, 'utf8');
  try {
    await rename(temp, path);
  } catch {
    // Packaged Windows apps can make same-directory rename look cross-volume.
    await writeFile(path, text, 'utf8');
    try {
      await unlink(temp);
    } catch {
      /* ignore */
    }
  }
}

export function emptyBinding() {
  return { filename: '', namespace: '', process: '', function: '', status: 'unbound', source: 'none' };
}

export function validateViewProfile(value) {
  if (!VIEW_PROFILES.includes(value)) {
    throw new BlueprintError('viewProfile must be one of: ' + VIEW_PROFILES.join(', '));
  }
  return value;
}

export function emptyGraph(scope) {
  return {
    schemaVersion: SCHEMA_VERSION,
    graphId: slugify(scope),
    title: scope,
    nodes: [],
    edges: [],
    findings: [],
  };
}

function requireString(obj, key, where, allowEmpty = true) {
  const value = obj[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new BlueprintError(where + '.' + key + ' must be a ' + (allowEmpty ? '' : 'non-empty ') + 'string');
  }
}

export function validateGraph(graph) {
  if (graph.schemaVersion !== SCHEMA_VERSION) throw new BlueprintError('schemaVersion must be ' + SCHEMA_VERSION);
  requireString(graph, 'graphId', 'graph', false);
  requireString(graph, 'title', 'graph');
  const nodes = graph.nodes;
  const edges = graph.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new BlueprintError('graph.nodes and graph.edges must be arrays');

  const nodeIds = new Set();
  const parents = new Map();
  nodes.forEach((node, index) => {
    const where = 'nodes[' + index + ']';
    if (typeof node !== 'object' || node === null) throw new BlueprintError(where + ' must be an object');
    for (const key of ['id', 'type', 'label']) requireString(node, key, where, false);
    requireString(node, 'description', where);
    const nodeId = node.id;
    if (nodeIds.has(nodeId)) throw new BlueprintError('Duplicate node id: ' + nodeId);
    nodeIds.add(nodeId);
    const parentId = node.parentId;
    if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
      throw new BlueprintError(where + '.parentId must be null or a node id');
    }
    parents.set(nodeId, parentId ?? null);
    const binding = node.codeBinding;
    if (typeof binding !== 'object' || binding === null) throw new BlueprintError(where + '.codeBinding must be an object');
    for (const key of ['filename', 'namespace', 'process', 'function']) requireString(binding, key, where + '.codeBinding');
    if (!BINDING_STATUS.has(binding.status)) throw new BlueprintError(where + '.codeBinding.status is invalid');
    if (!BINDING_SOURCE.has(binding.source)) throw new BlueprintError(where + '.codeBinding.source is invalid');
  });

  for (const [nodeId, parentId] of parents) {
    if (parentId !== null && !nodeIds.has(parentId)) {
      throw new BlueprintError('Node ' + nodeId + ' references missing parent ' + parentId);
    }
    const seen = new Set([nodeId]);
    let cursor = parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new BlueprintError('Parent cycle includes node ' + nodeId);
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }

  const edgeIds = new Set();
  edges.forEach((edge, index) => {
    const where = 'edges[' + index + ']';
    if (typeof edge !== 'object' || edge === null) throw new BlueprintError(where + ' must be an object');
    for (const key of ['id', 'source', 'target', 'type']) requireString(edge, key, where, false);
    for (const key of ['label', 'description']) requireString(edge, key, where);
    const edgeId = edge.id;
    if (edgeIds.has(edgeId)) throw new BlueprintError('Duplicate edge id: ' + edgeId);
    edgeIds.add(edgeId);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new BlueprintError('Edge ' + edgeId + ' references a missing node');
    }
  });

  const findings = graph.findings ?? [];
  if (!Array.isArray(findings)) throw new BlueprintError('graph.findings must be an array');
  const findingIds = new Set();
  const targetIds = { node: nodeIds, edge: edgeIds };
  findings.forEach((finding, index) => {
    const where = 'findings[' + index + ']';
    if (typeof finding !== 'object' || finding === null) throw new BlueprintError(where + ' must be an object');
    for (const key of ['id', 'message']) requireString(finding, key, where, false);
    const findingId = finding.id;
    if (findingIds.has(findingId)) throw new BlueprintError('Duplicate finding id: ' + findingId);
    findingIds.add(findingId);
    if (!FINDING_SEVERITY.has(finding.severity)) throw new BlueprintError(where + '.severity is invalid');
    if (!FINDING_SOURCE.has(finding.source)) throw new BlueprintError(where + '.source is invalid');
    const targets = finding.targets;
    if (!Array.isArray(targets) || !targets.length) throw new BlueprintError(where + '.targets must be a non-empty array');
    const seenTargets = new Set();
    targets.forEach((target, targetIndex) => {
      const targetWhere = where + '.targets[' + targetIndex + ']';
      if (typeof target !== 'object' || target === null) throw new BlueprintError(targetWhere + ' must be an object');
      for (const key of ['kind', 'id']) requireString(target, key, targetWhere, false);
      const kind = target.kind;
      const targetId = target.id;
      if (!FINDING_TARGET_KIND.has(kind)) throw new BlueprintError(targetWhere + '.kind is invalid');
      if (!targetIds[kind].has(targetId)) throw new BlueprintError('Finding ' + findingId + ' references missing ' + kind + ' ' + targetId);
      const key = kind + ':' + targetId;
      if (seenTargets.has(key)) throw new BlueprintError('Finding ' + findingId + ' repeats target ' + kind + ' ' + targetId);
      seenTargets.add(key);
    });
    const evidence = finding.evidence;
    if (!Array.isArray(evidence)) throw new BlueprintError(where + '.evidence must be an array');
    evidence.forEach((item, evidenceIndex) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new BlueprintError(where + '.evidence[' + evidenceIndex + '] must be a non-empty string');
      }
    });
    if (finding.source === 'agent' && finding.severity === 'error' && !evidence.length) {
      throw new BlueprintError(where + '.evidence is required for an agent error');
    }
  });
  return graph;
}

export function validateTargetGraph(graph) {
  validateGraph(graph);
  if (graph.findings && graph.findings.length) throw new BlueprintError('to-be graph must not contain findings');
  return graph;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateLayout(layout) {
  if (layout.schemaVersion !== SCHEMA_VERSION) throw new BlueprintError('layout.schemaVersion must be ' + SCHEMA_VERSION);
  for (const pane of ['asIs', 'toBe']) {
    const value = layout[pane];
    if (typeof value !== 'object' || value === null || typeof value.nodePositions !== 'object' || value.nodePositions === null) {
      throw new BlueprintError('layout.' + pane + '.nodePositions must be an object');
    }
    const zoom = value.zoom ?? 1.0;
    if (!isFiniteNumber(zoom) || zoom <= 0) throw new BlueprintError('layout.' + pane + '.zoom must be positive');
    const edgeRoutes = value.edgeRoutes ?? (value.edgeRoutes = {});
    const colors = value.nodeColors ?? {};
    if (typeof colors !== 'object' || colors === null) throw new BlueprintError('nodeColors must map node IDs to #RRGGBB colors');
    for (const [key, color] of Object.entries(colors)) {
      if (typeof key !== 'string' || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw new BlueprintError('nodeColors must map node IDs to #RRGGBB colors');
      }
    }
    const shapes = value.nodeShapes ?? {};
    if (typeof shapes !== 'object' || shapes === null) throw new BlueprintError('layout.' + pane + '.nodeShapes must be an object');
    for (const [key, shape] of Object.entries(shapes)) {
      if (typeof key !== 'string' || !SHAPES.includes(shape)) {
        throw new BlueprintError('layout.' + pane + '.nodeShapes must map node IDs to a known shape');
      }
    }
    if (typeof edgeRoutes !== 'object' || edgeRoutes === null) throw new BlueprintError('layout.' + pane + '.edgeRoutes must be an object');
    for (const [edgeId, route] of Object.entries(edgeRoutes)) {
      if (typeof edgeId !== 'string' || typeof route !== 'object' || route === null) {
        throw new BlueprintError('layout.' + pane + '.edgeRoutes contains an invalid entry');
      }
      if (!isFiniteNumber(route.x)) throw new BlueprintError('layout edge route ' + edgeId + '.x must be numeric');
      for (const axis of ['x', 'y']) {
        if (axis in route && !isFiniteNumber(route[axis])) throw new BlueprintError('layout edge route ' + edgeId + '.' + axis + ' must be finite');
      }
    }
    const anchors = value.edgeAnchors ?? {};
    if (typeof anchors !== 'object' || anchors === null) throw new BlueprintError('layout.' + pane + '.edgeAnchors must be an object');
    for (const [edgeId, ends] of Object.entries(anchors)) {
      if (typeof edgeId !== 'string' || typeof ends !== 'object' || ends === null) throw new BlueprintError('edgeAnchors contains an invalid entry');
      for (const [end, anchor] of Object.entries(ends)) {
        if (!['source', 'target'].includes(end) || typeof anchor !== 'object' || anchor === null) {
          throw new BlueprintError('edgeAnchors requires source/target anchors');
        }
        const offset = anchor.offset;
        if (!['left', 'right', 'top', 'bottom'].includes(anchor.side) || !isFiniteNumber(offset) || offset < 0 || offset > 1) {
          throw new BlueprintError('anchor requires a border side and finite offset in [0, 1]');
        }
      }
    }
    for (const [nodeId, position] of Object.entries(value.nodePositions)) {
      if (typeof nodeId !== 'string' || typeof position !== 'object' || position === null) {
        throw new BlueprintError('layout.' + pane + '.nodePositions contains an invalid entry');
      }
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!isFiniteNumber(position[key])) throw new BlueprintError('layout position ' + nodeId + '.' + key + ' must be numeric');
      }
    }
  }
  return layout;
}

// Profile-aware preset layout, ported from blueprint.py default_layout().
export function defaultLayout(graph, viewProfile = 'execution-flow') {
  validateViewProfile(viewProfile);
  const childGap = 48;
  const childInset = 56;
  const rootInset = 96;
  const rootGap = 80;
  const gridGap = 64;
  const positions = {};
  const children = new Map();
  const nodes = new Map();
  const nodeOrder = new Map();
  graph.nodes.forEach((node, index) => {
    nodes.set(node.id, node);
    nodeOrder.set(node.id, index);
    const key = node.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node.id);
  });
  const sizes = new Map();
  const childTops = new Map();

  const contentSize = (nodeId, root) => {
    const node = nodes.get(nodeId);
    const label = node.label || 'Untitled block';
    const description = node.description || '';
    const [baseWidth, maxWidth, minHeight] = root ? [360, 480, 178] : [280, 420, 112];
    const width = Math.min(maxWidth, Math.max(baseWidth, 150 + Math.min(label.length, 60) * 5));
    const labelChars = Math.max(18, Math.floor((width - 24) / 7));
    const descriptionChars = Math.max(24, Math.floor((width - 24) / 6));
    const labelLines = Math.max(1, Math.ceil(label.length / labelChars));
    const descriptionLines = description ? Math.min(3, Math.ceil(description.length / descriptionChars)) : 0;
    let contentHeight = 24 + 20 + 11 + 4 + labelLines * 20;
    if (descriptionLines) contentHeight += 5 + descriptionLines * 16;
    return [width, Math.max(minHeight, contentHeight), contentHeight + 14];
  };

  const verticalSubtreeSize = (nodeId, root = false) => {
    const [baseWidth0, baseHeight0, childTop] = contentSize(nodeId, root);
    childTops.set(nodeId, childTop);
    let baseWidth = baseWidth0;
    let baseHeight = baseHeight0;
    const childIds = children.get(nodeId) ?? [];
    const childSizes = childIds.map((childId) => verticalSubtreeSize(childId));
    if (childSizes.length) {
      baseWidth = Math.max(baseWidth, childInset * 2 + Math.max(...childSizes.map((size) => size[0])));
      const childrenHeight = childSizes.reduce((sum, size) => sum + size[1], 0) + childGap * (childSizes.length - 1);
      baseHeight = Math.max(baseHeight, childTop + childrenHeight + childInset);
    }
    sizes.set(nodeId, [baseWidth, baseHeight]);
    return sizes.get(nodeId);
  };

  const placeVerticalChildren = (parentId) => {
    let y = childTops.get(parentId);
    for (const childId of children.get(parentId) ?? []) {
      const [width, height] = sizes.get(childId);
      positions[childId] = { x: childInset, y, width, height };
      placeVerticalChildren(childId);
      y += height + childGap;
    }
  };

  const gridShape = (itemIds, columns) => {
    const columnWidths = new Array(columns).fill(0);
    const rowHeights = new Array(Math.ceil(itemIds.length / columns)).fill(0);
    itemIds.forEach((itemId, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const [width, height] = sizes.get(itemId);
      columnWidths[column] = Math.max(columnWidths[column], width);
      rowHeights[row] = Math.max(rowHeights[row], height);
    });
    return [columnWidths, rowHeights];
  };

  const gridOffsets = (lengths, gap) => {
    const offsets = [];
    let cursor = 0;
    for (const length of lengths) {
      offsets.push(cursor);
      cursor += length + gap;
    }
    return offsets;
  };

  const placeGrid = (itemIds, startX, startY, columns, gap) => {
    if (!itemIds.length) return [0, 0];
    columns = Math.max(1, Math.min(columns, itemIds.length));
    const [columnWidths, rowHeights] = gridShape(itemIds, columns);
    const xOffsets = gridOffsets(columnWidths, gap);
    const yOffsets = gridOffsets(rowHeights, gap);
    itemIds.forEach((itemId, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const [width, height] = sizes.get(itemId);
      positions[itemId] = { x: startX + xOffsets[column], y: startY + yOffsets[row], width, height };
    });
    const totalWidth = columnWidths.reduce((a, b) => a + b, 0) + gap * (columnWidths.length - 1);
    const totalHeight = rowHeights.reduce((a, b) => a + b, 0) + gap * (rowHeights.length - 1);
    return [totalWidth, totalHeight];
  };

  const architectureSubtreeSize = (nodeId, root = false) => {
    const [baseWidth0, baseHeight0, childTop] = contentSize(nodeId, root);
    childTops.set(nodeId, childTop);
    let baseWidth = baseWidth0;
    let baseHeight = baseHeight0;
    const childIds = children.get(nodeId) ?? [];
    for (const childId of childIds) architectureSubtreeSize(childId);
    if (childIds.length) {
      const ordered = [...childIds].sort((a, b) => {
        const aKey = (children.get(a)?.length ?? 0) > 0 ? 0 : 1;
        const bKey = (children.get(b)?.length ?? 0) > 0 ? 0 : 1;
        if (aKey !== bKey) return aKey - bKey;
        return nodeOrder.get(a) - nodeOrder.get(b);
      });
      const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(ordered.length))));
      const [contentWidth, contentHeight] = placeGrid(ordered, childInset, childTop, columns, gridGap);
      baseWidth = Math.max(baseWidth, childInset * 2 + contentWidth);
      baseHeight = Math.max(baseHeight, childTop + contentHeight + childInset);
    }
    sizes.set(nodeId, [baseWidth, baseHeight]);
    return sizes.get(nodeId);
  };

  const placeArchitectureRoots = (rootIds) => {
    const containerRoots = [...rootIds]
      .filter((rootId) => (children.get(rootId)?.length ?? 0) > 0)
      .sort((a, b) => {
        const areaA = sizes.get(a)[0] * sizes.get(a)[1];
        const areaB = sizes.get(b)[0] * sizes.get(b)[1];
        return areaB - areaA || nodeOrder.get(a) - nodeOrder.get(b);
      });
    const containerSet = new Set(containerRoots);
    const externalRoots = rootIds.filter((rootId) => !containerSet.has(rootId));
    if (!containerRoots.length) {
      placeGrid(externalRoots, rootInset, 48, Math.min(4, externalRoots.length), rootGap);
      return;
    }
    const containerColumns = Math.min(2, Math.max(1, Math.ceil(Math.sqrt(containerRoots.length))));
    const [containerWidth] = placeGrid(containerRoots, rootInset, 48, containerColumns, rootGap);
    placeGrid(externalRoots, rootInset + containerWidth + rootGap, 48, Math.min(2, externalRoots.length), rootGap);
  };

  const stateMachineSize = (nodeId, root = false) => {
    const [baseWidth0, baseHeight0, childTop] = contentSize(nodeId, root);
    childTops.set(nodeId, childTop);
    let baseWidth = baseWidth0;
    let baseHeight = baseHeight0;
    const childIds = children.get(nodeId) ?? [];
    for (const childId of childIds) {
      verticalSubtreeSize(childId);
      placeVerticalChildren(childId);
    }

    const stateIds = childIds.filter((childId) => nodes.get(childId)?.type === 'state');
    const stateSet = new Set(stateIds);
    const supportIds = childIds.filter((childId) => !stateSet.has(childId));
    const outgoing = new Map(stateIds.map((id) => [id, []]));
    const incoming = new Map(stateIds.map((id) => [id, []]));
    const policyTargets = new Set();
    const supportSet = new Set(supportIds);
    for (const edge of graph.edges) {
      const source = edge.source;
      const target = edge.target;
      if (stateSet.has(source) && stateSet.has(target)) {
        outgoing.get(source).push(target);
        incoming.get(target).push(source);
      } else if (supportSet.has(source) && stateSet.has(target)) {
        policyTargets.add(target);
      }
    }

    let seeds = stateIds.filter((stateId) => !incoming.get(stateId).length && outgoing.get(stateId).length && !policyTargets.has(stateId));
    if (!seeds.length && stateIds.length) seeds = [stateIds[0]];
    const distance = new Map();
    const queue = [...seeds];
    for (const seed of seeds) distance.set(seed, 0);
    while (queue.length) {
      const current = queue.shift();
      for (const target of outgoing.get(current)) {
        if (distance.has(target)) continue;
        distance.set(target, distance.get(current) + 1);
        queue.push(target);
      }
    }

    const layers = new Map();
    for (const stateId of stateIds) {
      if (!distance.has(stateId)) continue;
      const step = distance.get(stateId);
      if (!layers.has(step)) layers.set(step, []);
      layers.get(step).push(stateId);
    }
    let x = childInset;
    let mainBottom = childTop;
    for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
      const layerIds = layers.get(layer);
      const layerColumns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(layerIds.length))));
      const [layerWidth, layerHeight] = placeGrid(layerIds, x, childTop, layerColumns, gridGap);
      mainBottom = Math.max(mainBottom, childTop + layerHeight);
      x += layerWidth + 120;
    }
    const mainRight = Math.max(childInset, x - 120);

    const policyIds = supportIds.filter((supportId) => graph.edges.some((edge) => edge.source === supportId && stateSet.has(edge.target)));
    const safetyIds = stateIds.filter((stateId) => policyTargets.has(stateId) && !distance.has(stateId));
    const safetyRow = [...policyIds, ...safetyIds];
    const rowY = mainBottom + 96;
    const [safetyWidth, safetyHeight] = placeGrid(safetyRow, childInset, rowY, Math.max(1, safetyRow.length), gridGap);

    const placed = new Set([...distance.keys(), ...safetyRow]);
    const remaining = childIds.filter((childId) => !placed.has(childId));
    const remainingY = rowY + safetyHeight + (safetyRow.length ? 96 : 0);
    const [remainingWidth, remainingHeight] = placeGrid(remaining, childInset, remainingY, Math.min(4, remaining.length), gridGap);

    const right = Math.max(mainRight, childInset + safetyWidth, childInset + remainingWidth);
    const bottom = Math.max(mainBottom, rowY + safetyHeight, remainingY + remainingHeight);
    baseWidth = Math.max(baseWidth, right + childInset);
    baseHeight = Math.max(baseHeight, bottom + childInset);
    sizes.set(nodeId, [baseWidth, baseHeight]);
    return sizes.get(nodeId);
  };

  const roots = children.get(null) ?? [];
  let zoom = 1.0;
  if (viewProfile === 'execution-flow') {
    for (const rootId of roots) verticalSubtreeSize(rootId, true);
    let y = 48;
    for (const rootId of roots) {
      const [width, height] = sizes.get(rootId);
      positions[rootId] = { x: rootInset, y, width, height };
      placeVerticalChildren(rootId);
      y += height + rootGap;
    }
  } else if (viewProfile === 'component-architecture') {
    for (const rootId of roots) architectureSubtreeSize(rootId, true);
    placeArchitectureRoots(roots);
    zoom = 0.6;
  } else {
    for (const rootId of roots) {
      if (nodes.get(rootId)?.type === 'state-machine') stateMachineSize(rootId, true);
      else architectureSubtreeSize(rootId, true);
    }
    placeGrid(roots, rootInset, 48, Math.min(2, roots.length), rootGap);
    zoom = 0.6;
  }
  return { nodePositions: positions, edgeRoutes: {}, zoom };
}

export function blueprintRoot(workspace) {
  return join(workspace, '.blueprint');
}

export async function setCurrentSession(workspace, sessionId) {
  await atomicWriteJson(join(blueprintRoot(workspace), 'current.json'), { sessionId });
}

export async function getCurrentSessionDir(workspace) {
  let current;
  try {
    current = await readJson(join(blueprintRoot(workspace), 'current.json'));
  } catch {
    throw new BlueprintError('No active blueprint session');
  }
  if (!current || typeof current.sessionId !== 'string') throw new BlueprintError('No active blueprint session');
  return join(blueprintRoot(workspace), 'sessions', current.sessionId);
}

export async function createSession(scope, workspace, asIs, viewProfile = 'execution-flow') {
  validateGraph(asIs);
  validateViewProfile(viewProfile);
  const base = join(blueprintRoot(workspace), 'sessions');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '').replace(/\..*/, '').slice(0, 14);
  const baseId = slugify(scope) + '-' + stamp;
  let sessionDir = join(base, baseId);
  let suffix = 2;
  while (await pathExists(sessionDir)) {
    sessionDir = join(base, baseId + '-' + suffix);
    suffix += 1;
  }
  await mkdir(sessionDir, { recursive: true });
  const now = utcNow();
  const id = basename(sessionDir);
  const session = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: id,
    scope,
    viewProfile,
    workspace,
    createdAt: now,
    updatedAt: now,
    token: randomBytes(24).toString('base64url'),
  };
  const graphLayout = defaultLayout(asIs, viewProfile);
  const paneLayout = () => ({ ...structuredClone(graphLayout), edgeAnchors: {}, nodeColors: {}, nodeShapes: {} });
  const layout = { schemaVersion: SCHEMA_VERSION, asIs: paneLayout(), toBe: paneLayout() };
  const handoff = { schemaVersion: SCHEMA_VERSION, status: 'idle', updatedAt: now };
  const toBe = structuredClone(asIs);
  delete toBe.findings;
  validateTargetGraph(toBe);

  await atomicWriteJson(join(sessionDir, 'session.json'), session);
  await atomicWriteJson(join(sessionDir, 'as-is.json'), asIs);
  await atomicWriteJson(join(sessionDir, 'to-be.json'), toBe);
  await atomicWriteJson(join(sessionDir, 'layout.json'), layout);
  await atomicWriteJson(join(sessionDir, 'handoff.json'), handoff);
  await setCurrentSession(workspace, id);
  return sessionDir;
}

export async function loadSession(sessionDir) {
  for (const name of SESSION_FILES) {
    if (!(await pathExists(join(sessionDir, name)))) throw new BlueprintError('Session is missing: ' + name);
  }
  const session = await readJson(join(sessionDir, 'session.json'));
  session.viewProfile = validateViewProfile(session.viewProfile ?? 'execution-flow');
  const asIs = validateGraph(await readJson(join(sessionDir, 'as-is.json')));
  const toBe = validateTargetGraph(await readJson(join(sessionDir, 'to-be.json')));
  const layout = validateLayout(await readJson(join(sessionDir, 'layout.json')));
  const handoff = await readJson(join(sessionDir, 'handoff.json'));
  return { dir: sessionDir, session, asIs, toBe, layout, handoff };
}

export function publicSession(session) {
  const { token, ...rest } = session;
  return rest;
}

export function continueCommand(sessionDir) {
  return '/blueprint continue "' + sessionDir + '"';
}

function byId(items) {
  const map = new Map();
  for (const item of items) map.set(item.id, item);
  return map;
}

function itemDiff(before, after) {
  const left = byId(before);
  const right = byId(after);
  const added = [];
  const removed = [];
  const modified = [];
  for (const id of [...right.keys()].sort()) if (!left.has(id)) added.push(right.get(id));
  for (const id of [...left.keys()].sort()) if (!right.has(id)) removed.push(left.get(id));
  for (const id of [...left.keys()].filter((key) => right.has(key)).sort()) {
    const a = left.get(id);
    const b = right.get(id);
    if (JSON.stringify(a) !== JSON.stringify(b)) modified.push({ id, before: a, after: b });
  }
  return { added, removed, modified };
}

export function semanticDiff(asIs, toBe) {
  validateGraph(asIs);
  validateGraph(toBe);
  const nodes = itemDiff(asIs.nodes, toBe.nodes);
  const edges = itemDiff(asIs.edges, toBe.edges);
  const titleChanged = asIs.title !== toBe.title;
  const changed =
    titleChanged ||
    nodes.added.length + nodes.removed.length + nodes.modified.length + edges.added.length + edges.removed.length + edges.modified.length > 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    changed: Boolean(changed),
    title: titleChanged ? { before: asIs.title, after: toBe.title } : null,
    nodes,
    edges,
    summary: {
      nodesAdded: nodes.added.length,
      nodesRemoved: nodes.removed.length,
      nodesModified: nodes.modified.length,
      edgesAdded: edges.added.length,
      edgesRemoved: edges.removed.length,
      edgesModified: edges.modified.length,
    },
  };
}
