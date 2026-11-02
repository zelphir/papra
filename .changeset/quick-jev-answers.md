---
'@papra/app': patch
---

When the optional Jev decision model is configured (`AI_DECISION_MODEL` and `TYPESAFE_API_KEY`), document enrichment now asks it closed questions first (clear filename, existing tags, boolean and select custom properties) and only sends the language model what is still unresolved. Document text is sent to TypeSafe. Without the decision model, or when it fails, nothing changes.
