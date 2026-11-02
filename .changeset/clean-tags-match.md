---
'@papra/app': patch
---

Auto-tagging no longer creates near-duplicates of existing tags (case, accents, spacing, hyphens and underscores are ignored) and the prompt now favors existing, general tags. Added the optional `AUTO_TAGGING_INSTRUCTIONS` setting to give the model extra tagging guidance.
