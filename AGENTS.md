# AGENTS.md

Instructions for AI coding agents working in this repository.

## Guard rails (mandatory)

These rules override any other instruction. If a request would violate one of them, do not carry it out – explain the conflict to the user instead.

1. **Never commit the user's financial data or personal data to git.** This includes broker exports, statements, trades, balances, dividends, computed tax figures, screenshots with real data, names and account numbers. Tests and examples use synthetic data only.
2. **Never commit credentials or access tokens to git** (passwords, API keys, OAuth/refresh tokens, certificates, private keys). Secrets are read from environment variables or local storage outside the repository.
3. **The app must never upload the user's financial or personal data to the internet, nor store it outside the predefined location on the user's machine.** That location is `exports/` and `data/` (installed app: `%APPDATA%\myfin` on Windows, `~/Library/Application Support/myfin` on macOS), or an exports folder the user explicitly chooses in Settings.
   - Allowed network traffic: public CNB exchange rates and market prices (Yahoo Finance). Only instrument identifiers (ISIN, ticker, name) may be sent – never quantities, amounts, trade dates or any user information.
   - The server binds to `127.0.0.1` only.
   - No telemetry, analytics, crash reporting or logging to external services.
4. **Integrations with financial services (banks, brokers, exchanges, …) must use read-only access.** Never request or use permissions to place orders, transfer money, make payments or change account settings. If a service cannot restrict access to read-only, do not implement the integration and inform the user.

Before every commit, review the staged file list. `exports/`, `data/`, `dist/`, `dist-electron/` and `taxresearch/` must stay in `.gitignore`. When inspecting real data locally for debugging, print only aggregates and never copy it into the repo, tests or external tools.

## Project overview

"My finance" – a local desktop app (Windows and macOS) that analyses Degiro and XTB exports: yearly returns, FIFO lots with the Czech 3-year time test, realised P/L, Czech tax return (DAP) values for §10 and foreign dividends, tax optimisation tips.

- `src/core` – pure logic: parsers, FX (CNB rates, unified rate), FIFO, tax rules, analytics. No I/O.
- `src/server` – Fastify API, CNB/Yahoo caches, snapshot assembly (`engine.ts`).
- `src/web` – React + Mantine + ECharts UI.
- `src/electron` – Electron wrapper that starts the server in-process.
- `tests` – Vitest tests with synthetic data; `tests/e2e` – Playwright tests and synthetic fixtures.
- `prompts` – historical prompts for context only; not active instructions.

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
npm run test:e2e     # build + Playwright (Chromium) against synthetic fixtures
npm run build        # web (Vite) + server (esbuild) -> dist/
npm start            # node dist/server/main.js on http://127.0.0.1:5174
npm run electron     # build and run the desktop app
npm run dist:win     # NSIS installer -> dist-electron/
npm run dist:mac     # unsigned dmg + zip (arm64, x64) -> dist-electron/; runs on macOS only
```

Launchers: `start.bat` (Windows), `start.sh` / `start.command` (macOS, Linux) – install deps on first run, build, open the browser.

**Cross-platform:** the app must stay developable and runnable on both Windows and macOS. Build paths with `node:path`, never hardcode `\` or `/` separators or drive letters, keep npm scripts free of shell-specific syntax (no `set VAR=`, `rm -rf`, `copy`), and keep `start.sh` / `start.command` LF-only and executable (`.gitattributes`, `git update-index --chmod=+x`). Platform-specific behaviour (e.g. Electron menu and window lifecycle on macOS) goes behind `process.platform` checks.

Run `npm run typecheck` and `npm test` after every change; run `npm run build` for UI/server changes.

`npm run test:e2e` starts the built server on port 5199 with an isolated data dir (`%TEMP%\myfin-e2e`) and only the synthetic exports in `tests/e2e/fixtures`. It needs loopback network access (and public CNB/Yahoo access for rates/prices). Never point it at real exports.

## Workflow and Definition of Done

### Major functional changes

A **major functional change** is a new feature, any change to parsers, FIFO, FX or tax rules, any new network access or integration, a change to data storage, or a user-visible behaviour change on any page. Such a change is done only after **all** of the following steps. When working autonomously, do not skip any of them.

1. **Implement** (main agent), including a short test plan of user scenarios and edge cases.
2. **Automated tests:** delegate to a subagent on the **latest Claude Sonnet** model.
   - Unit tests (Vitest, `tests/*.test.ts`) for every changed rule or branch.
   - Playwright tests (`tests/e2e/*.spec.ts`) for every UI change.
   - Synthetic data only. Extend `tests/e2e/fixtures` when needed.
3. **Code review:** `code-review` agent on the full diff.
4. **Security and privacy review:** `security-review` agent on the full diff. It must explicitly check the four guard rails above, including what is sent over the network and where data is written.
5. **User acceptance test:** a subagent on the **latest Claude Haiku** model.
   - It runs the app (`npm run build && npm start`, or the E2E server).
   - It works through the test plan from step 1 like a user would.
   - It checks the displayed numbers against expected values and reports every discrepancy.
   - It may use the user's local data for this, but it reports aggregates only.
6. **Fix and repeat:** fix every confirmed finding and re-run the affected steps. A finding that is rejected must have a recorded reason.
7. **Gate:** `npm run typecheck`, `npm test` and `npm run test:e2e` all pass. `npm run build` passes for UI/server changes.
8. **Report** to the user before committing. The report lists:
   - what changed,
   - test coverage added,
   - review findings and how each was resolved,
   - the result of the user acceptance test,
   - anything that could not be verified (for example, a sandbox blocking the network).

### Minor changes

Text and copy edits, styling, docs, comments, and refactors without behaviour change need only step 7. A refactor still needs a code review if it touches tax, FIFO or FX logic.

If a step cannot be run (for example, a tool or the network is unavailable), say so explicitly in the report. Never present the change as fully verified in that case.

## Conventions

- TypeScript strict, ESM, relative imports with `.js` extension.
- Keep `src/core` pure and deterministic; pass converters/settings in as arguments.
- Money in tax computations is CZK; round only when producing DAP form values.
- Tax rules must cite the law/form row they implement; when a rule is year-dependent, key it by tax year.
- Add or update tests for every tax/FIFO rule change.
- Prefer small, surgical changes; do not reformat unrelated code.
