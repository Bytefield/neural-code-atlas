# NCA — Neural Code Atlas

> Las reglas globales de `~/.claude/CLAUDE.md` (Skills, Delegación Obligatoria por Modelo,
> Branch Protection, Pre-Commit Review) se aplican íntegramente aquí.
> Este archivo sólo añade contexto y overrides específicos del repo.

## Stack

- **Runtime:** Node.js v24 (nativo Windows, sin nvm)
- **Lenguaje:** TypeScript — compilar con `npm run build` (tsc)
- **DB:** SQLite via `better-sqlite3` (síncrono, sin async/await en queries)
- **Package manager:** `npm` — este repo usa npm, no pnpm
- **Test runner:** `node test/run.js` — runner casero, no jest/vitest

## Comandos habituales

```powershell
npm run build          # compilar TypeScript → dist/
node test/run.js       # suite completa
node dist/cli.js migrate --status   # estado de migraciones
node dist/cli.js evolve             # análisis de warnings en live DB
```

## Estructura clave

```
src/
  migrations/     ← schema versionado; NUNCA tocar el schema fuera de aquí
  storage.ts      ← capa de DB; stmts preparados en prepareStatements()
  context.ts      ← ranking y expansión de contexto
  evolve.ts       ← análisis estático (R001-R006)
  graph.ts        ← GraphSnapshot (inmutable, construido una vez por análisis)
  scanner.ts      ← indexado de ficheros
test/run.js       ← tests de integración (Node.js puro, sin framework)
.nca/nca.db       ← DB local del repo (gitignored)
```

## Contexto de agentes

- Tarjeta base: `.claude/agent-context/all.md`
- Reglas de herramientas: `.claude/rules/nca-tools.md`
- Indexar tarjetas: `nca vault scan .claude/agent-context/`

## Convenciones del proyecto

- **Conventional commits** en inglés: `feat:`, `fix:`, `perf:`, `refactor:`, `test:`
- **Migraciones:** versiones contiguas desde 1; nunca modificar migraciones ya mergeadas
- **Tests:** TDD estricto en bugs — el test debe fallar ANTES del fix (rojo → verde)
- **Branch naming:** `fix/<descripción>`, `perf/<descripción>`, `feat/<descripción>`
- **No auto-merge** de PRs — el usuario hace merge desde la UI de GitHub

## No cargar por defecto

| Ruta | Motivo |
|------|--------|
| `node_modules/` | Siempre excluir |
| `dist/` | Output compilado, no fuente de verdad |
| `.nca/` | DB binaria |
| `src/vault/__fixtures__/` | Fixtures de test, no contexto de dominio |
