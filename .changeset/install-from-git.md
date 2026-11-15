---
'@swissspidy/assay': patch
---

Installs from GitHub (`npm install github:swissspidy/assay#<commit>`) now work: the package builds `dist/` in `prepare`, which npm runs for git dependencies, instead of only when packing.
