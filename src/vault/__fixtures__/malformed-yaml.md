---
id: test-malformed
type: [unclosed-bracket
invalid: yaml: structure: here
---

This is the body after malformed frontmatter.

The parser should catch the YAML error, write a warning to stderr, and still return a valid ParsedNote with body content parsed.

It should have status vigente and the hash should be computed from this body.
