---
'@swissspidy/assay': patch
---

`assay review --format html` prints a standalone page instead of a fragment: a doctype, `lang`, the UTF-8 encoding, a viewport, light and dark support, a title, and a Content Security Policy that blocks scripts and subresources. `reviewSheet(cs, { format: 'html' })` still returns a fragment for embedding.
