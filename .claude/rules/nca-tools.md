# nca-tools — Routing de herramientas NCA

Usar `nca ask` SIEMPRE ANTES de grep/cat. Usar `nca vault search` para referencias
a decisiones y arquitectura.

| Situación | Acción |
|-----------|--------|
| Leer `storage.ts`, `context.ts`, `test/run.js` (>300 líneas) | `nca ask` + Read (nunca grep directo) |
| Explorar callers de un símbolo en `src/` | `nca ask "<símbolo>"` |
| Navegar docs y decisiones arquitectónicas | `nca vault search "<tema>"` |
| Entender ripple effect de un cambio | `nca flow "<función>"` |
| Ver doc↔code coupling | `nca related "<símbolo_o_doc>"` |
| Implementar un bug fix acotado | Hacer directo (repo pequeño, <20 ficheros TS) |
| Review pre-merge en `migrations/` o contratos públicos | `architect-reviewer` |
