---
'@swissspidy/assay': patch
---

The stress test is faster (about 1.2× on the committed check sets), with the same reports. A check that reads a part of the snapshot a variant, mutant or success claim replaced now takes the reference's result when the change misses what it reads there: the tree roles the edit touched, the requests it added or removed, the values at the probe pointers, storage keys and URL parts the check reads. Variants that change only what no check of the set reads (extra content, a wrapped main, doubled spaces, network noise, retries, unrelated storage) are recorded as accepted without being built.
