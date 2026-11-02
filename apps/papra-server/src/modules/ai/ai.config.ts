import { aiModelIdSchema } from './ai.schemas';
import { booleanishSchema, urlSchema } from '../config/config.schemas';
import type { AppConfigDefinition } from '../config/config.types';
import * as v from 'valibot';
import { AI_DEFAULT_MODEL_ENV_KEY } from './ai.constants';
import { openAiAdaptersConfig } from './adapters/openai-compatible/openai-compatible.config';
import { anthropicAdaptersConfig } from './adapters/anthropic/anthropic.ai-adapters.config';

export const aiConfig = {
  isEnabled: {
    doc: 'Whether AI features are enabled',
    schema: booleanishSchema,
    env: 'AI_IS_ENABLED',
    default: false,
  },
  credits: {
    isEnabled: {
      doc: 'Whether to enforce AI credit limits and track credit usage. Enable for metered instances; leave disabled for self-hosting.',
      schema: booleanishSchema,
      env: 'AI_CREDITS_IS_ENABLED',
      default: false,
    },
  },
  adapters: {
    anthropic: anthropicAdaptersConfig,
    ...openAiAdaptersConfig,
  },
  defaultModelId: {
    doc: 'Default AI model to use when no specific model is specified, the format is <adapterId>://<modelName>, e.g. "ollama://llama3.1:8b".',
    schema: v.optional(aiModelIdSchema),
    env: AI_DEFAULT_MODEL_ENV_KEY,
    default: undefined,
  },
  decisions: {
    modelId: {
      doc: 'Optional TypeSafe Jev decision model, as a plain model name, e.g. "jev-latest". Leave unset to disable decisions. When set (with TYPESAFE_API_KEY), document text is sent to TypeSafe, a third party, in addition to your language model provider.',
      schema: v.optional(v.string()),
      env: 'AI_DECISION_MODEL',
      default: undefined,
    },
    apiKey: {
      doc: 'API key for TypeSafe, used by the decision model. Document text is sent to TypeSafe when decisions are enabled.',
      schema: v.string(),
      env: 'TYPESAFE_API_KEY',
      default: '',
    },
    baseUrl: {
      doc: 'Base URL of the TypeSafe API, used by the decision model.',
      schema: urlSchema,
      env: 'TYPESAFE_BASE_URL',
      default: 'https://api.typesafe.ai',
    },
  },
} as const satisfies AppConfigDefinition;
