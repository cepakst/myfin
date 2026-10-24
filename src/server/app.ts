import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { detectFileKind } from '../core/parsers/index.js';
import { mergeSettings, type Settings } from '../core/settings.js';
import { computeSnapshot, instrumentDetail, state } from './engine.js';
import { DEFAULT_EXPORTS_DIR, DEMO_SETTINGS_FILE, ensureDir, WEB_DIST } from './paths.js';
import { loadSettings, saveSettings } from './store.js';

export async function createServer() {
  // `settings` = the user's settings (incl. the demo flag); demo mode edits a separate settings file
  let settings = loadSettings();
  let demoSettings = loadSettings(DEMO_SETTINGS_FILE);
  const active = () => (settings.demo ? demoSettings : settings);
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024, files: 10 } });

  // a change requested during a running computation (e.g. switching to demo data) is applied right after it
  let pending: { refreshMarket: boolean } | null = null;
  const recompute = (refreshMarket = false): boolean => {
    if (state.status === 'loading') {
      pending = { refreshMarket: refreshMarket || !!pending?.refreshMarket };
      return false;
    }
    void computeSnapshot(active(), { refreshMarket, demo: !!settings.demo }).finally(() => {
      const next = pending;
      pending = null;
      if (next) recompute(next.refreshMarket);
    });
    return true;
  };

  app.get('/api/status', async () => ({ status: state.status, progress: state.progress, error: state.error, generatedAt: state.snapshot?.generatedAt }));

  app.get('/api/snapshot', async (_req, reply) => {
    if (!state.snapshot) return reply.code(503).send({ status: state.status, progress: state.progress, error: state.error });
    return state.snapshot;
  });

  app.get<{ Params: { id: string } }>('/api/instrument/:id', async (req, reply) => {
    const d = instrumentDetail(decodeURIComponent(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Instrument nenalezen' });
    return d;
  });

  app.get('/api/settings', async () => ({ settings: active(), defaultExportsDir: DEFAULT_EXPORTS_DIR, demo: !!settings.demo }));

  app.put<{ Body: Partial<Settings> }>('/api/settings', async (req) => {
    // the demo flag is switched only via /api/demo; demo settings never carry an exports folder
    const { demo: _ignored, ...body } = req.body ?? {};
    if (settings.demo) {
      demoSettings = mergeSettings({ ...demoSettings, ...body, exportsDir: undefined, demo: undefined });
      saveSettings(demoSettings, DEMO_SETTINGS_FILE);
    } else {
      settings = mergeSettings({ ...settings, ...body, demo: settings.demo });
      saveSettings(settings);
    }
    recompute();
    return { settings: active() };
  });

  app.put<{ Body: { enabled?: boolean } }>('/api/demo', async (req) => {
    const enabled = req.body?.enabled === true;
    if (enabled !== !!settings.demo) {
      settings = mergeSettings({ ...settings, demo: enabled || undefined });
      saveSettings(settings);
      recompute();
    }
    return { demo: enabled, settings: active() };
  });

  app.post<{ Body: { refreshMarket?: boolean } | undefined }>('/api/reload', async (req) => ({ started: recompute(!!req.body?.refreshMarket) }));

  app.post('/api/upload', async (req, reply) => {
    const dir = settings.exportsDir || DEFAULT_EXPORTS_DIR;
    const saved: { file: string; kind: string }[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      const fname = basename(part.filename).replace(/[^\w.\- ]/g, '_');
      const kind = detectFileKind(fname, new Uint8Array(buf));
      if (kind === 'UNKNOWN') return reply.code(400).send({ error: `Neznámý formát souboru ${fname}` });
      const sub = ensureDir(join(dir, kind === 'XTB' ? 'xtb' : 'degiro'));
      // a newer export of the same kind replaces the previous one (exports contain full history)
      const archive = ensureDir(join(dir, '_archiv'));
      for (const old of readdirSync(sub)) {
        const p = join(sub, old);
        if (statSync(p).isDirectory()) continue;
        const oldKind = /\.(csv|xlsx|zip)$/i.test(old) ? detectFileKind(old, new Uint8Array(readFileSync(p))) : 'UNKNOWN';
        if (oldKind === kind) renameSync(p, join(archive, `${Date.now()}_${old}`));
      }
      writeFileSync(join(sub, fname), buf);
      saved.push({ file: fname, kind });
    }
    // uploads always go to the user's exports; the demo view is not affected by them
    if (!settings.demo) recompute();
    return { saved };
  });

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      setHeaders: (res, path) => {
        res.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.addHook('onSend', async (req, reply) => {
      if (!req.url.startsWith('/api/'))
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) return reply.code(404).send({ error: 'Not found' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }

  return {
    app,
    start: async (port: number) => {
      const address = await app.listen({ port, host: '127.0.0.1' });
      recompute();
      return address;
    },
  };
}
