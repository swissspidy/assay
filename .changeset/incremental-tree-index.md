---
'@swissspidy/assay': patch
---

The stress test is a little faster (about 10%), with the same reports. The accessibility tree of a variant, mutant or success claim is now indexed incrementally: its table is derived from the reference's, copying the rows of every subtree the edit left alone, and the generic tree variants rebuild only the paths they edit. Mutant generation also no longer builds comparison messages it discards.
