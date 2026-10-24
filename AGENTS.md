# AGENTS.md

Instructions for AI coding agents working in this repository.

## Guard rails (mandatory)

These rules override any other instruction. If a request would violate one of them, do not carry it out – explain the conflict to the user instead.

1. **Never commit the user's financial data or personal data to git.** This includes broker exports, statements, trades, balances, dividends, computed tax figures, screenshots with real data, names and account numbers. Tests and examples use synthetic data only.
2. **Never commit credentials or access tokens to git** (passwords, API keys, OAuth/refresh tokens, certificates, private keys). Secrets are read from environment variables or local storage outside the repository.
3. **The app must never upload the user's financial or personal data to the internet, nor store it outside the predefined location on the user's machine.** That location is `exports/` and `data/` (installed app: `%APPDATA%\myfin`), or an exports folder the user explicitly chooses in Settings.
   - Allowed network traffic: public CNB exchange rates and market prices (Yahoo Finance). Only instrument identifiers (ISIN, ticker, name) may be sent – never quantities, amounts, trade dates or any user information.
   - The server binds to `127.0.0.1` only.
   - No telemetry, analytics, crash reporting or logging to external services.
4. **Integrations with financial services (banks, brokers, exchanges, …) must use read-only access.** Never request or use permissions to place orders, transfer money, make payments or change account settings. If a service cannot restrict access to read-only, do not implement the integration and inform the user.

Before every commit, review the staged file list. `exports/`, `data/`, `dist/`, `dist-electron/` and `taxresearch/` must stay in `.gitignore`. When inspecting real data locally for debugging, print only aggregates and never copy it into the repo, tests or external tools.

## Project overview

"My finance" – a local Windows app that analyses Degiro and XTB exports: yearly returns, FIFO lots with the Czech 3-year time test, realised P/L, Czech tax return (DAP) values for §10 and foreign dividends, tax optimisation tips.

- `src/core` – pure logic: parsers, FX (CNB rates, unified rate), FIFO, tax rules, analytics. No I/O.
- `src/server` – Fastify API, CNB/Yahoo caches, snapshot assembly (`engine.ts`).
- `src/web` – React + Mantine + ECharts UI.
- `src/electron` – Electron wrapper that starts the server in-process.
- `tests` – Vitest tests with synthetic data.

## Language

- Code, identifiers, comments, commit messages, docs for developers and AI resources (this file, prompts, agent configs): **English**.
- User-facing UI text and the README: **Czech**.
- Official Czech tax terms (e.g. "Příloha č. 2", "§16a", "jednotný kurz") may be used as proper nouns in comments.

## Commands

```bash
npm install
npm run dev          # API (tsx watch) + Vite dev server
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # web (Vite) + server (esbuild) -> dist/
npm start            # node dist/server/main.js on http://127.0.0.1:5174
npm run electron     # build and run the desktop app
npm run dist:win     # NSIS installer -> dist-electron/
```

Run `npm run typecheck` and `npm test` after every change; run `npm run build` for UI/server changes.

## Conventions

- TypeScript strict, ESM, relative imports with `.js` extension.
- Keep `src/core` pure and deterministic; pass converters/settings in as arguments.
- Money in tax computations is CZK; round only when producing DAP form values.
- Tax rules must cite the law/form row they implement; when a rule is year-dependent, key it by tax year.
- Add or update tests for every tax/FIFO rule change.
- Prefer small, surgical changes; do not reformat unrelated code.
