# Compiled tiny-tracker checks

Each task was compiled from its instruction, its "Then" clauses and one correct reference run.
The remaining labelled runs were held out; the last column counts how many the compiled checks judge correctly.

| Task | Requirements | Checks | Evidence per requirement | Held-out runs correct |
|---|---|---|---|---|
| 01-create-bug | 2 | 2 | R1:probe, R2:probe | 4/4 |
| 02-create-high-priority | 2 | 2 | R1:probe, R2:probe | 3/3 |
| 03-close-issue | 1 | 1 | R1:probe | 4/4 |
| 04-reopen-issue | 1 | 2 | R1:probe+network | 3/3 |
| 05-assign-bob | 1 | 1 | R1:probe | 3/3 |
| 06-add-feature-label | 2 | 2 | R1:probe, R2:probe | 3/3 |
| 07-comment | 1 | 1 | R1:probe | 4/4 |
| 08-rename | 1 | 1 | R1:probe | 3/3 |
| 09-unassign | 1 | 1 | R1:probe | 3/3 |
| 10-filter-open-bugs | 2 | 4 | R1:url+a11y, R2:url+a11y | 4/4 |
