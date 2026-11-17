import { existsSync } from 'node:fs';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply } from 'fastify';
import type { DateRange, ImportMode } from '../core/exportStore.js';
import { mergeSettings, type Settings } from '../core/settings.js';
import { effectiveCategories, sanitizeAccountsConfig } from '../core/accounts/analytics.js';
import { MAX_RULES, ruleSignature, sanitizeRules } from '../core/accounts/categories.js';
import { accountsState, loadAccountsConfig, refreshAccounts, saveAccountsConfig } from './accountsEngine.js';
import { computeSnapshot, instrumentDetail, state } from './engine.js';
import { cancelImport, commitImport, ImportError, isInside, previewInbox, previewUpload, replanImport } from './importer.js';
import { DATA_DIR, DEFAULT_EXPORTS_DIR, DEMO_SETTINGS_FILE, STORE_DIR, WEB_DIST } from './paths.js';
import { loadSettings, saveSettings } from './store.js';
import { buildTaxReport } from './taxReport.js';

export async function createServer() {
  // `settings` = the user's settings (incl. the demo flag); demo mode edits a separate settings file
  let settings = loadSettings();
  let demoSettings = loadSettings(DEMO_SETTINGS_FILE);
  const active = () => (settings.demo ? demoSettings : settings);
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024, files: 10 } });

  // Only the app itself may use the API: reject DNS-rebinding hosts and cross-site writes
  // (a web page in the user's browser could otherwise post forged exports to 127.0.0.1).
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const hostnameOf = (h: string | undefined) => (h ?? '').replace(/:\d+$/, '').toLowerCase();
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return reply.code(403).send({ error: 'Forbidden host' });
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return reply.code(403).send({ error: 'Cross-site request' });
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* invalid origin */
      }
      if (!LOCAL_HOSTS.has(hostnameOf(host))) return reply.code(403).send({ error: 'Cross-site request' });
    } else if (origin === 'null') return reply.code(403).send({ error: 'Cross-site request' });
  });

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

  app.get('/api/status', async () => ({
    status: state.status,
    progress: state.progress,
    error: state.error,
    generatedAt: state.snapshot?.generatedAt,
    accountsGeneratedAt: accountsState.snapshot?.generatedAt,
  }));

  // --- accounts module (bank statements) ---
  app.get('/api/accounts', async (_req, reply) => {
    if (!accountsState.snapshot) return reply.code(503).send({ status: state.status, progress: state.progress, error: state.error });
    return accountsState.snapshot;
  });

  app.put<{ Body: unknown }>('/api/accounts/config', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    if (!accountsState.snapshot) return reply.code(503).send({ error: 'Data se ještě načítají' });
    // a malformed request must never overwrite the saved configuration with an empty one
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.version !== 1) return reply.code(400).send({ error: 'Neplatné nastavení účtů' });
    // demo mode keeps its own configuration file, so the user's real configuration is never touched
    // parts the client does not send keep their stored value (each Settings section saves its own part);
    // `categories: null` restores the default categories
    let stored;
    try {
      stored = loadAccountsConfig(accountsState.demo, true);
    } catch {
      stored = undefined; // a damaged file is replaced by what the user saves now
    }
    const config = sanitizeAccountsConfig({ ...stored, ...(req.body as Record<string, unknown>) });
    saveAccountsConfig(accountsState.demo, config);
    return refreshAccounts();
  });

  // assigns categories to transactions (null = back to automatic) and optionally adds rules
  app.post<{ Body: { assign?: Record<string, string | null>; rules?: unknown[] } }>('/api/accounts/categorize', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    if (!accountsState.snapshot) return reply.code(503).send({ error: 'Data se ještě načítají' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return reply.code(400).send({ error: 'Neplatný požadavek' });
    const { assign, rules } = req.body;
    if ((assign !== undefined && (typeof assign !== 'object' || assign === null || Array.isArray(assign))) || (rules !== undefined && !Array.isArray(rules))) {
      return reply.code(400).send({ error: 'Neplatný požadavek' });
    }
    let cfg;
    try {
      cfg = loadAccountsConfig(accountsState.demo, true);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
    const overrides: Record<string, string> = Object.assign(Object.create(null), cfg.overrides);
    for (const [k, v] of Object.entries(assign ?? {})) {
      if (v === null) delete overrides[k];
      else overrides[k] = v;
    }
    // new rules go first: the latest decision of the user wins over older rules
    // an older rule with the same condition is replaced, so repeated decisions do not pile up
    const newRules = sanitizeRules(rules ?? [], new Set(effectiveCategories(cfg).map((c) => c.id)));
    const sameMatch = new Set(newRules.map((r) => ruleSignature(r.match)));
    const kept = cfg.rules.filter((r) => !sameMatch.has(ruleSignature(r.match)));
    if (newRules.length + kept.length > MAX_RULES) return reply.code(400).send({ error: `Pravidel může být nejvýše ${MAX_RULES}. Smažte nepotřebná pravidla v Nastavení.` });
    const merged = sanitizeAccountsConfig({ ...cfg, overrides, rules: [...newRules, ...kept] });
    saveAccountsConfig(accountsState.demo, merged);
    return refreshAccounts();
  });

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

  app.get<{ Params: { year: string } }>('/api/tax-report/:year', async (req, reply) => {
    const snap = state.snapshot;
    if (!snap || !state.ledger || !state.fx || !state.settings) return reply.code(503).send({ error: 'Data se ještě načítají' });
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || !snap.years.includes(year)) return reply.code(404).send({ error: 'Rok není k dispozici' });
    const buf = await buildTaxReport({ year, snapshot: snap, ledger: state.ledger, fx: state.fx, settings: state.settings });
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="myfin-dane-${year}${snap.demo ? '-demo' : ''}.xlsx"`)
      .header('Cache-Control', 'no-store')
      .send(buf);
  });

  app.put<{ Body: Partial<Settings> }>('/api/settings', async (req, reply) => {
    // the demo flag is switched only via /api/demo; demo settings never carry an exports folder
    const { demo: _ignored, ...body } = req.body ?? {};
    // the exports folder is read-only for the app, so it must not overlap with the app's own data
    const dir = typeof body.exportsDir === 'string' ? body.exportsDir.trim() : '';
    if (dir && (isInside(dir, DATA_DIR) || isInside(DATA_DIR, dir))) {
      return reply.code(400).send({ error: `Složka s exporty nesmí být složka s daty aplikace (${DATA_DIR}) ani ji obsahovat.` });
    }
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
      // never serve (or save configuration for) the other mode's accounts while recomputing
      accountsState.snapshot = undefined;
      recompute();
    }
    return { demo: enabled, settings: active() };
  });

  app.post<{ Body: { refreshMarket?: boolean } | undefined }>('/api/reload', async (req) => ({ started: recompute(!!req.body?.refreshMarket) }));

  // --- import of exports (split by year, preview + user decision on conflicts) ---
  // imports go to the store in the data dir (the exports folder is only read); disabled while the demo is shown
  const exportsDir = () => settings.exportsDir || DEFAULT_EXPORTS_DIR;
  const importFailed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ImportError) return reply.code(e.status).send({ error: e.message });
    return reply.code(500).send({ error: `Import selhal: ${(e as Error).message}` });
  };
  const demoBlocked = (reply: FastifyReply) => reply.code(409).send({ error: 'V režimu demo dat nelze importovat. Přepněte na „Moje exporty“.' });

  app.post('/api/import/preview', async (req, reply) => {
    if (settings.demo) return demoBlocked(reply);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'Chybí soubor' });
    try {
      return await previewUpload(STORE_DIR, file.filename, await file.toBuffer());
    } catch (e) {
      return importFailed(reply, e);
    }
  });

  app.post<{ Body: { path?: string } }>('/api/import/inbox', async (req, reply) => {
    if (settings.demo) return demoBlocked(reply);
    if (typeof req.body?.path !== 'string') return reply.code(400).send({ error: 'Chybí cesta' });
    try {
      return await previewInbox(STORE_DIR, exportsDir(), req.body.path);
    } catch (e) {
      return importFailed(reply, e);
    }
  });

  app.post<{ Body: { id?: string; mode?: ImportMode; range?: DateRange } }>('/api/import/commit', async (req, reply) => {
    if (settings.demo) return demoBlocked(reply);
    const { id, mode, range } = req.body ?? {};
    if (typeof id !== 'string' || typeof mode !== 'string') return reply.code(400).send({ error: 'Chybí id nebo způsob importu' });
    try {
      const r = await commitImport(id, mode, range && typeof range === 'object' ? { from: String(range.from), to: String(range.to) } : undefined, STORE_DIR);
      recompute();
      return r;
    } catch (e) {
      return importFailed(reply, e);
    }
  });

  app.post<{ Body: { id?: string; range?: DateRange } }>('/api/import/replan', async (req, reply) => {
    if (settings.demo) return demoBlocked(reply);
    const { id, range } = req.body ?? {};
    if (typeof id !== 'string' || !range || typeof range !== 'object') return reply.code(400).send({ error: 'Chybí id nebo období' });
    try {
      return await replanImport(id, { from: String(range.from), to: String(range.to) });
    } catch (e) {
      return importFailed(reply, e);
    }
  });

  app.post<{ Body: { id?: string } }>('/api/import/cancel', async (req) => {
    // a skipped file from the exports folder changes its status in Settings
    if (typeof req.body?.id === 'string' && (await cancelImport(req.body.id))) recompute();
    return { ok: true };
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
