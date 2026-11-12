import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BlueprintError,
  createSession,
  getCurrentSessionDir,
  loadSession,
  publicSession,
  continueCommand,
  semanticDiff,
  validateTargetGraph,
  validateLayout,
  readJson,
  atomicWriteJson,
  utcNow,
  SCHEMA_VERSION,
  emptyGraph,
} from './core.js';

export const name = 'blueprint';
export const inject = ['tools', 'systemPrompt'];

const WEB_KEYS = ['webServer', 'httpServer'];
const WS_KEYS = ['workspaceRegistry', 'workspace'];
const ASSET_TYPES = {
  'editor.html': 'text/html',
  'app.js': 'application/javascript',
  'styles.css': 'text/css',
};
const MAX_BODY = 8 * 1024 * 1024;

const USAGE_SECTION = [
  'When the user runs "/blueprint <scope>" (also "blueprint <scope>" or "$blueprint <scope>"), you are the Blueprint author. Inspect the real code, then generate a code-grounded As-Is semantic graph and persist it with blueprint_new so the right-sidebar Blueprint panel shows it. The left As-Is pane is semantically read-only (layout may be adjusted); the right To-Be pane is editable; the user clicks "Update Agent" when the target design is ready.',
  '',
  'Choose one primary viewProfile per session:',
  '- "execution-flow": a trigger/tick/request path from input to output (call, signal, data and pipeline aspects may coexist). Default vertical.',
  '- "component-architecture": ownership, containment and external boundaries (process, subsystem, module). Default wide/tiled.',
  '- "state-workflow": persistent states, guards, events and transitions. Default layered.',
  'A whole-system request (e.g. "/blueprint FSM") produces three independent sessions: architecture, critical execution/data flow, and state/lifecycle. A focused request produces only the requested view. Check producers AND consumers and source anchors; never claim completeness from node count.',
  '',
  'Pass to blueprint_new: scope, viewProfile, and asIs as a JSON string {schemaVersion:1, graphId, title, nodes:[{id,type,label,description,parentId,codeBinding:{filename,namespace,process,function,status,source}}], edges:[{id,source,target,type,label,description}], findings:[...]}.',
  '- IDs are stable semantic identity. parentId nests sub-blocks. codeBinding may stay empty; unbound blocks remain visible and are confirmed at plan time.',
  '- Current-code problems belong in As-Is `findings` (severity error|warning|info, message, targets, evidence). An agent `error` requires current-source evidence (file:line or a reproducible search). Never infer severity from label text.',
  '- Keep descriptions to the shortest accurate responsibility phrase; full detail lives in code bindings and findings.',
  '',
  'When the user clicks "Update Agent", the panel writes a pending handoff. On the next turn, call blueprint_status and blueprint_diff, treat the edited To-Be as the TARGET design, re-read the current code referenced by affected nodes, and produce: semantic changes with code evidence and unresolved mappings, a complete staged task list, and questions for core block responsibility, boundary, inputs/outputs, failure behavior and unbound code mapping. Then call blueprint_consume. Stop at the plan; do not modify product code unless separately authorized.',
  '',
  'Layout is display-only and never enters the semantic diff: block position/size/color, trace waypoints and border endpoints persist in layout only. Presets choose the initial layout; they never repack saved blocks. The panel defaults to a white/light theme and fits the graph to the viewport.',
].join('\n');

function assetPath(name) {
  return fileURLToPath(new URL('../assets/' + name, import.meta.url));
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'blueprint:usage', order: 118, text: USAGE_SECTION });

  function workspaceDir(exec) {
    const ws = ctx.get(WS_KEYS[0]) ?? ctx.get(WS_KEYS[1]);
    if (ws) {
      try {
        const list = ws.list();
        if (list && list.length) return list[0].path;
      } catch {
        /* ignore */
      }
    }
    return exec?.agent?.session?.header?.cwd ?? process.cwd();
  }

  ctx.tools.register(defineTool({
    name: 'blueprint_new',
    description: 'Create a Blueprint session from a code-grounded As-Is semantic graph and make it the active design the right-sidebar panel shows.',
    parameters: {
      scope: { type: 'string', required: true, description: 'Design scope text, e.g. "FSM whole system" or "FlwrApp 1kHz loop".' },
      viewProfile: { type: 'string', required: true, description: 'execution-flow | component-architecture | state-workflow' },
      asIs: { type: 'string', required: true, description: 'As-Is semantic graph as a JSON string.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { sessionDir: { type: 'string', required: true }, sessionId: { type: 'string', required: true } } },
      render: (args, value) => [{ type: 'text', text: 'blueprint session created: ' + value.sessionDir }],
    },
    async execute(args, exec) {
      let graph;
      try {
        graph = JSON.parse(args.asIs);
      } catch (error) {
        throw new Error('asIs is not valid JSON: ' + error.message);
      }
      const dir = await createSession(args.scope, workspaceDir(exec), graph, args.viewProfile);
      return { sessionDir: dir, sessionId: dir.split(/[\\/]/).pop() };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'blueprint_blank',
    description: 'Create an empty Blueprint session for freeform block-diagram / flow drawing (no As-Is code graph). The To-Be pane starts blank and editable; open the Blueprint sidebar panel to draw.',
    parameters: {
      scope: { type: 'string', required: true, description: 'Diagram title/scope.' },
      viewProfile: { type: 'string', description: 'execution-flow | component-architecture | state-workflow (default execution-flow).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { sessionDir: { type: 'string', required: true }, sessionId: { type: 'string', required: true }, viewProfile: { type: 'string', required: true } } },
      render: (args, value) => [{ type: 'text', text: 'blank blueprint created: ' + value.sessionDir + ' (open the Blueprint sidebar panel to draw)' }],
    },
    async execute(args, exec) {
      const viewProfile = args.viewProfile || 'execution-flow';
      const dir = await createSession(args.scope, workspaceDir(exec), emptyGraph(args.scope), viewProfile);
      return { sessionDir: dir, sessionId: dir.split(/[\\/]/).pop(), viewProfile };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'blueprint_status',
    description: 'Read the active Blueprint session: metadata, As-Is/To-Be graphs, layout, handoff status and semantic diff.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
    async execute(_args, exec) {
      const dir = await getCurrentSessionDir(workspaceDir(exec));
      const loaded = await loadSession(dir);
      return {
        session: publicSession(loaded.session),
        asIs: loaded.asIs,
        toBe: loaded.toBe,
        layout: loaded.layout,
        handoff: loaded.handoff,
        continueCommand: continueCommand(dir),
        diff: semanticDiff(loaded.asIs, loaded.toBe),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'blueprint_diff',
    description: 'Return the deterministic semantic diff between As-Is and To-Be (layout excluded).',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
    async execute(_args, exec) {
      const dir = await getCurrentSessionDir(workspaceDir(exec));
      const loaded = await loadSession(dir);
      return semanticDiff(loaded.asIs, loaded.toBe);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'blueprint_consume',
    description: 'Mark the current pending handoff consumed after reading the To-Be design and the diff.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
    async execute(_args, exec) {
      const dir = await getCurrentSessionDir(workspaceDir(exec));
      const handoff = await readJson(join(dir, 'handoff.json'));
      handoff.status = 'consumed';
      handoff.updatedAt = utcNow();
      await atomicWriteJson(join(dir, 'handoff.json'), handoff);
      return { consumed: true, handoff };
    },
  }));

  let registered = false;
  const register = () => {
    if (registered) return;
    const web = ctx.get(WEB_KEYS[0]) ?? ctx.get(WEB_KEYS[1]);
    const ws = ctx.get(WS_KEYS[0]) ?? ctx.get(WS_KEYS[1]);
    if (web === undefined || ws === undefined) return;
    registered = true;

    const webWorkspace = () => {
      const roots = ws.list().map((w) => w.path);
      return roots[0] ?? process.cwd();
    };

    const sendJson = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };

    const serveAsset = async (res, assetName) => {
      try {
        const body = await readFile(assetPath(assetName));
        res.writeHead(200, {
          'content-type': ASSET_TYPES[assetName] + '; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    };

    const payloadFor = async () => {
      const dir = await getCurrentSessionDir(webWorkspace());
      const loaded = await loadSession(dir);
      return {
        session: publicSession(loaded.session),
        asIs: loaded.asIs,
        toBe: loaded.toBe,
        layout: loaded.layout,
        handoff: loaded.handoff,
        continueCommand: continueCommand(dir),
        diff: semanticDiff(loaded.asIs, loaded.toBe),
      };
    };

    const readBody = (req) => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) reject(new BlueprintError('Request body too large'));
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new BlueprintError('Invalid JSON body: ' + error.message));
        }
      });
      req.on('error', reject);
    });

    const save = async (req, res, isHandoff) => {
      try {
        const body = await readBody(req);
        const dir = await getCurrentSessionDir(webWorkspace());
        const loaded = await loadSession(dir);
        const toBe = body.toBe && typeof body.toBe === 'object' ? validateTargetGraph(body.toBe) : null;
        const layout = body.layout && typeof body.layout === 'object' ? validateLayout(body.layout) : null;
        if (!toBe || !layout) throw new BlueprintError('toBe and layout are required');
        await atomicWriteJson(join(dir, 'to-be.json'), toBe);
        await atomicWriteJson(join(dir, 'layout.json'), layout);
        loaded.session.updatedAt = utcNow();
        await atomicWriteJson(join(dir, 'session.json'), loaded.session);
        const diff = semanticDiff(loaded.asIs, toBe);
        let handoff = loaded.handoff;
        if (isHandoff) {
          handoff = {
            schemaVersion: SCHEMA_VERSION,
            status: 'pending',
            updatedAt: utcNow(),
            continueCommand: continueCommand(dir),
            diffSummary: diff.summary,
          };
          await atomicWriteJson(join(dir, 'handoff.json'), handoff);
        }
        sendJson(res, 200, { saved: true, handoff, diff });
      } catch (error) {
        const message = error instanceof BlueprintError ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    };

    const route = (path, handler, label) => ctx.effect(() => web.register({ kind: 'exact', path, handler }), label);

    route('/plugins/blueprint/editor', async (_req, res) => serveAsset(res, 'editor.html'), 'blueprint: editor route');
    route('/plugins/blueprint/app.js', async (_req, res) => serveAsset(res, 'app.js'), 'blueprint: app.js route');
    route('/plugins/blueprint/styles.css', async (_req, res) => serveAsset(res, 'styles.css'), 'blueprint: styles.css route');
    route('/plugins/blueprint/api/session', async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      try {
        sendJson(res, 200, await payloadFor());
      } catch (error) {
        const message = error instanceof BlueprintError ? error.message : String(error);
        sendJson(res, 404, { error: message });
      }
    }, 'blueprint: session route');
    route('/plugins/blueprint/api/diff', async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      try {
        const dir = await getCurrentSessionDir(webWorkspace());
        const loaded = await loadSession(dir);
        sendJson(res, 200, semanticDiff(loaded.asIs, loaded.toBe));
      } catch (error) {
        const message = error instanceof BlueprintError ? error.message : String(error);
        sendJson(res, 404, { error: message });
      }
    }, 'blueprint: diff route');
    route('/plugins/blueprint/api/save', async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      await save(req, res, false);
    }, 'blueprint: save route');
    route('/plugins/blueprint/api/handoff', async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      await save(req, res, true);
    }, 'blueprint: handoff route');
  };
  register();
  ctx.on('internal/service', (serviceName) => {
    if (WEB_KEYS.includes(serviceName) || WS_KEYS.includes(serviceName)) register();
  });
}
