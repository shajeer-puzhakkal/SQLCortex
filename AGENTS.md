# AGENTS.md

This file defines default operating instructions for coding agents working in `d:\sqlcortex`.

## Scope
- Applies to the full monorepo unless a deeper `AGENTS.md` overrides parts of it.
- Priority order: direct user request > nested `AGENTS.md` > this file.

## Project Map
- `apps/web`: Next.js frontend.
- `apps/api`: Express + Prisma backend (`/api/v1/*`).
- `services/ai-services`: FastAPI service.
- `extensions/sqlcortex-vscode`: VS Code extension.
- `packages/shared`: shared contracts/utilities used across services.
- `docs/contracts`: cross-service contract docs.
- `codex_tasks`: sprint and phase implementation specs.

## Working Rules
- Implement the requested task end-to-end when feasible.
- Prefer minimal, targeted diffs; avoid refactors unrelated to the request.
- Do not revert user changes unless explicitly asked.
- Use non-destructive commands only unless user approves otherwise.
- If requirements are ambiguous, choose the safest practical interpretation and document assumptions.

## Code Standards
- Preserve existing naming, module boundaries, and style in touched files.
- Keep TypeScript strict-safe; avoid `any` unless unavoidable.
- Use ASCII by default unless the file already relies on Unicode.
- Add short comments only when logic is non-obvious.
- Prefer small reusable helpers over duplicated logic.

## Validation
- Run the narrowest useful validation for changed areas.
- Typical commands:
- API: `cd apps/api && npm test` or targeted script if available.
- Extension build: `cd extensions/sqlcortex-vscode && npm run build`.
- TypeScript compile check: `npm run compile` in package/workspace where changed.
- If you cannot run checks, state exactly what was not run and why.

## VS Code Extension Guidance
- Keep command IDs stable once introduced.
- Register commands in `extensions/sqlcortex-vscode/package.json` and handlers in `extensions/sqlcortex-vscode/src/extension.ts`.
- Keep webview placeholders lightweight unless task explicitly requires production UI.
- Prefer incremental state additions under `extensions/sqlcortex-vscode/src/state`.

## API and Safety Guidance
- Respect read-only execution expectations for SQL operations.
- Keep response/error shapes aligned with existing contracts.
- When changing request/response contracts, update:
- `apps/api/src/contracts.ts`
- `packages/shared/src/contracts.ts` (if mirrored/shared)
- relevant docs in `docs/contracts`

## Deliverable Format
- Provide:
- summary of what changed
- file paths touched
- validation performed (or gaps)
- concise next steps only when useful
