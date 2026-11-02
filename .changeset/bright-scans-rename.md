---
'@papra/app': minor
---

Added AI document titles: when `AI_ENRICHMENT_TITLES_ENABLED` is `true`, documents with meaningless names such as `SCAN_0001.pdf` get a descriptive name from their content. Documents renamed by a user are never touched.
