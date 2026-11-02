import * as v from 'valibot';
import type { AppConfigDefinition } from '../config/config.types';
import { aiModelIdSchema } from '../ai/ai.schemas';
import { booleanishSchema } from '../config/config.schemas';

export const documentEnrichmentConfig = {
  modelId: {
    doc: 'AI model to use for document enrichment, the format is <adapterId>://<modelName>, e.g. "ollama://llama3.1:8b". When not set, falls back to the auto-tagging model.',
    schema: v.optional(aiModelIdSchema),
    env: 'AI_ENRICHMENT_MODEL',
    default: undefined,
  },
  titles: {
    isEnabled: {
      doc: 'Whether AI can give a descriptive name to documents the user has not renamed. Needs to enable global AI features too, with `AI_IS_ENABLED`.',
      schema: booleanishSchema,
      env: 'AI_ENRICHMENT_TITLES_ENABLED',
      default: false,
    },
  },
  dates: {
    isEnabled: {
      doc: 'Whether AI can fill in the date of documents that do not have one yet, from their content. Needs to enable global AI features too, with `AI_IS_ENABLED`.',
      schema: booleanishSchema,
      env: 'AI_ENRICHMENT_DATES_ENABLED',
      default: false,
    },
  },
} as const satisfies AppConfigDefinition;
