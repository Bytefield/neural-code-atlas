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
node test/run.js       # suite completa (expected: N pass, 1 fail AC5 pre-existing)
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
.nca/backups/     ← backups forenses (gitignored)
```

## Delegación — routing específico para este repo

Aplica la tabla global con estos matices:

| Situación | Acción |
|-----------|--------|
| Leer `storage.ts`, `context.ts`, `test/run.js` (>300 líneas) | `nca ask` + Read (nunca grep directo) |
| Explorar callers de un símbolo en `src/` | `nca ask "<símbolo>"` |
| Navegar docs y decisiones arquitectónicas | `nca vault search "<tema>"` |
| Entender ripple effect de un cambio | `nca flow "<función>"` |
| Ver doc↔code coupling | `nca related "<símbolo_o_doc>"` |
| Implementar un bug fix acotado | Hacer directo (repo pequeño, <20 ficheros TS) |
| Review pre-merge de cambios que tocan `migrations/` o contratos públicos | `architect-reviewer` |

> **Nota:** Usar `nca ask` siempre ANTES de grep/cat. Usar `nca vault search` para referencias a
> decisiones y arquitectura. Para implementación: orquestador o `general-purpose` con `model: sonnet`.

## Convenciones del proyecto

- **Conventional commits** en inglés: `feat:`, `fix:`, `perf:`, `refactor:`, `test:`
- **Migraciones:** versiones contiguas desde 1; nunca modificar migraciones ya mergeadas
- **Tests:** TDD estricto en bugs — el test debe fallar ANTES del fix (rojo → verde)
- **Branch naming:** `fix/<descripción>`, `perf/<descripción>`, `feat/<descripción>`
- **No auto-merge** de PRs — el usuario hace merge desde la UI de GitHub

## Estado del proyecto (auditoría de 7 bugs — actualizado 2026-05-25)

De la auditoría original de 7 bugs:
- **Resueltos y mergeados:** 1 (LMD), 3 (CAC), 4 (BNB), 5 (SRS), 6 (WUR), 7 (AC5) ✅
- **Pendiente sin documentación:** 2 (desconocido) ⚠️

Auditoría completa → `../../Papi_Obsidian_Vault/02-Projects/nca/AUDITORIA-BUGS.md`
Tests: 31/31 pasando (100%)
