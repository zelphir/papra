---
'@papra/app': minor
---

Added AI custom properties: when `AI_ENRICHMENT_CUSTOM_PROPERTIES_ENABLED` is `true`, empty custom property values of documents (text, number, date, boolean, select and multi select) are filled from their content, using the organization's property definitions. Properties that already have a value are never changed.
