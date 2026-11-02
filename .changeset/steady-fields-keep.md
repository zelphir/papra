---
'@papra/app': patch
---

Fixed AI document enrichment losing every suggestion when the model returned one invalid field (an unknown tag, a select option that does not exist or a badly formatted number): the invalid field is now ignored and the valid ones are still applied.
