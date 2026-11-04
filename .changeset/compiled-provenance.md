---
'@swissspidy/assay': minor
---

Compiled check sets now record their provenance in an optional `compiled` field: the compiler version, the model client, the models that served the turns and when the model ran (`CompileOptions.provenance` overrides the model and time). Cassettes record when they were recorded, and `replayModel` and `recordingModel` expose it as `recorded`, so a replayed compile reproduces the original file.
