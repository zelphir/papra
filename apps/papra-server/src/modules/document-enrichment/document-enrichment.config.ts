import * as v from 'valibot';
import type { AppConfigDefinition } from '../config/config.types';
import { aiModelIdSchema } from '../ai/ai.schemas';

export const documentEnrichmentConfig = {
  modelId: {
    doc: 'AI model to use for document enrichment, the format is <adapterId>://<modelName>, e.g. "ollama://llama3.1:8b". When not set, falls back to the auto-tagging model.',
    schema: v.optional(aiModelIdSchema),
    env: 'AI_ENRICHMENT_MODEL',
    default: undefined,
  },
} as const satisfies AppConfigDefinition;
