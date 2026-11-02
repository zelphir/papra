import type { Logger } from '@crowlog/logger';
import type { Config } from '../config/config.types';
import { resolveTextAdapter } from './adapters/ai-adapters.usecases';
import { EventType, chat as tanstackChat, decide as tanstackDecide } from '@tanstack/ai';
import type { ChatMiddleware, EvaluateResult, WireQuestion } from '@tanstack/ai';
import { createTypesafeDecider } from '@tanstack/ai-typesafe';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import type { GenericSchema, InferOutput } from 'valibot';
import { createLogger } from '../shared/logger/logger';
import { generateId } from '../shared/random/ids';
import {
  createAiCreditsGenerationMiddleware,
  createAiCreditsMiddleware,
} from '../ai-credits/ai-credits.middlewares';
import type { AiCreditsUsageSource } from '../ai-credits/ai-credits.types';
import type { AiCreditsRepository } from '../ai-credits/ai-credits.repository';
import { checkOrganizationHasSufficientAiCredits } from '../ai-credits/ai-credits.usecases';
import { createError } from '../shared/errors/errors';
import { isDecisionModelConfigured } from './ai.models';
import { createGetOrganizationPlanUsecase } from '../plans/plans.usecases';
import type { PlansRepository } from '../plans/plans.repository';
import type { PlanEntitlementDefinitionRegistry } from '../plan-entitlements/plan-entitlements.registry';
import type { PlanEntitlementsRepository } from '../plan-entitlements/plan-entitlements.repository';
import type { SubscriptionsRepository } from '../subscriptions/subscriptions.repository';

// The adapter ignores its timeout option, only the abort signal cancels a call
const DECISION_TIMEOUT_MS = 30_000;

export type AiServices = ReturnType<typeof createAiServices>;

// When no schema is provided, the model output is not constrained and the raw text is returned.
type GenerateStructuredDataResult<Schema extends GenericSchema | undefined> =
  Schema extends GenericSchema ? InferOutput<Schema> : string;

export function createAiServices({
  config,
  aiCreditsRepository,
  plansRepository,
  planEntitlementDefinitionRegistry,
  planEntitlementsRepository,
  subscriptionsRepository,
  logger = createLogger({ namespace: 'ai.services' }),
}: {
  config: Config;
  aiCreditsRepository: AiCreditsRepository;
  plansRepository: PlansRepository;
  planEntitlementDefinitionRegistry: PlanEntitlementDefinitionRegistry;
  planEntitlementsRepository: PlanEntitlementsRepository;
  subscriptionsRepository: SubscriptionsRepository;
  logger?: Logger;
}) {
  // Not using injectArguments here: it relies on Parameters/ReturnType, which collapse the
  // `Schema` type parameter to its constraint, making the result `unknown`. A thin generic
  // wrapper preserves inference so callers get back InferOutput<Schema>.
  return {
    generateStructuredData: async <Schema extends GenericSchema | undefined = undefined>(args: {
      modelId: string;
      schema?: Schema;
      userPrompt: string;
      systemPrompt?: string;
      source: AiCreditsUsageSource;
      organizationId: string;
    }): Promise<GenerateStructuredDataResult<Schema>> =>
      generateStructuredData({
        ...args,
        config,
        logger,
        aiCreditsRepository,
        plansRepository,
        planEntitlementDefinitionRegistry,
        planEntitlementsRepository,
        subscriptionsRepository,
      }),

    isDecisionModelConfigured: isDecisionModelConfigured({ config }),

    // Same generic wrapper as above, so callers get typed answers per question.
    decide: async <Questions extends Record<string, WireQuestion>>(args: {
      state: string | object;
      questions: Questions;
      source: AiCreditsUsageSource;
      organizationId: string;
    }): Promise<EvaluateResult<Questions>> =>
      decide({
        ...args,
        config,
        logger,
        aiCreditsRepository,
        plansRepository,
        planEntitlementDefinitionRegistry,
        planEntitlementsRepository,
        subscriptionsRepository,
      }),
  };
}

async function generateStructuredData<Schema extends GenericSchema | undefined>({
  modelId,
  schema,
  userPrompt,
  systemPrompt,
  source,
  organizationId,
  aiCreditsRepository,
  config,
  logger,
  plansRepository,
  planEntitlementDefinitionRegistry,
  planEntitlementsRepository,
  subscriptionsRepository,
}: {
  modelId: string;
  schema?: Schema;
  userPrompt: string;
  systemPrompt?: string;
  source: AiCreditsUsageSource;
  organizationId: string;
  config: Config;
  logger: Logger;
  aiCreditsRepository: AiCreditsRepository;
  plansRepository: PlansRepository;
  planEntitlementDefinitionRegistry: PlanEntitlementDefinitionRegistry;
  planEntitlementsRepository: PlanEntitlementsRepository;
  subscriptionsRepository: SubscriptionsRepository;
}): Promise<GenerateStructuredDataResult<Schema>> {
  const adapter = resolveTextAdapter({
    modelId,
    config,
  });

  await ensureSufficientAiCredits({
    organizationId,
    config,
    aiCreditsRepository,
    plansRepository,
    planEntitlementDefinitionRegistry,
    planEntitlementsRepository,
    subscriptionsRepository,
  });

  const data = await tanstackChat({
    adapter,
    messages: userPrompt ? [{ role: 'user', content: userPrompt }] : undefined,
    outputSchema: schema ? toStandardJsonSchema(schema) : undefined,
    threadId: generateId({ prefix: 'ai' }),
    promptCache: 'none',
    stream: false,
    systemPrompts: systemPrompt ? [systemPrompt] : undefined,
    middleware: [
      createLogMiddleware({ logger, context: { modelId } }),
      ...(config.ai.credits.isEnabled
        ? [
            createAiCreditsMiddleware({
              modelId,
              organizationId,
              source,
              logger,
              aiCreditsRepository,
            }),
          ]
        : []),
    ],
  });

  return data as GenerateStructuredDataResult<Schema>;
}

async function decide<Questions extends Record<string, WireQuestion>>({
  state,
  questions,
  source,
  organizationId,
  config,
  logger,
  ...creditsDeps
}: {
  state: string | object;
  questions: Questions;
  source: AiCreditsUsageSource;
  organizationId: string;
  config: Config;
  logger: Logger;
  aiCreditsRepository: AiCreditsRepository;
  plansRepository: PlansRepository;
  planEntitlementDefinitionRegistry: PlanEntitlementDefinitionRegistry;
  planEntitlementsRepository: PlanEntitlementsRepository;
  subscriptionsRepository: SubscriptionsRepository;
}): Promise<EvaluateResult<Questions>> {
  const { modelId, apiKey, baseUrl } = config.ai.decisions;

  if (!isDecisionModelConfigured({ config }) || !modelId) {
    throw createError({
      code: 'ai.decision_model_not_configured',
      message: 'AI decision model is not configured. Set AI_DECISION_MODEL and TYPESAFE_API_KEY.',
      statusCode: 500,
      isInternal: true,
    });
  }

  await ensureSufficientAiCredits({ organizationId, config, ...creditsDeps });

  try {
    return (await tanstackDecide({
      adapter: createTypesafeDecider(modelId, apiKey, { baseURL: baseUrl }),
      state,
      questions,
      abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      // The adapter logs failures to the console itself, we log them below without the response detail
      debug: false,
      middleware: config.ai.credits.isEnabled
        ? [
            createAiCreditsGenerationMiddleware({
              // Rates are keyed by <adapterId>://<modelName>
              modelId: `typesafe://${modelId}`,
              organizationId,
              source,
              logger,
              aiCreditsRepository: creditsDeps.aiCreditsRepository,
            }),
          ]
        : [],
    })) as EvaluateResult<Questions>;
  } catch (error) {
    // Only the status is logged, the error message can contain the provider response
    const status = getErrorStatus(error);

    logger.error(
      { modelId, status },
      status === 401
        ? 'TypeSafe rejected the API key (401), check TYPESAFE_API_KEY'
        : 'Error making AI decisions',
    );

    throw error;
  }
}

function getErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;

  return typeof status === 'number' ? status : undefined;
}

async function ensureSufficientAiCredits({
  organizationId,
  config,
  aiCreditsRepository,
  plansRepository,
  planEntitlementDefinitionRegistry,
  planEntitlementsRepository,
  subscriptionsRepository,
}: {
  organizationId: string;
  config: Config;
  aiCreditsRepository: AiCreditsRepository;
  plansRepository: PlansRepository;
  planEntitlementDefinitionRegistry: PlanEntitlementDefinitionRegistry;
  planEntitlementsRepository: PlanEntitlementsRepository;
  subscriptionsRepository: SubscriptionsRepository;
}) {
  if (!config.ai.credits.isEnabled) {
    return;
  }

  await checkOrganizationHasSufficientAiCredits({
    organizationId,
    aiCreditsRepository,
    getOrganizationPlan: createGetOrganizationPlanUsecase({
      plansRepository,
      planEntitlementDefinitionRegistry,
      planEntitlementsRepository,
      subscriptionsRepository,
    }),
  });
}

export function logDecisionModelConfiguration({
  config,
  logger,
}: {
  config: Config;
  logger: Logger;
}) {
  const { modelId, apiKey, baseUrl } = config.ai.decisions;

  if (!modelId && !apiKey) {
    return;
  }

  if (!modelId || !apiKey) {
    logger.warn(
      { hasModelId: Boolean(modelId), hasApiKey: Boolean(apiKey) },
      'AI decisions are disabled: both AI_DECISION_MODEL and TYPESAFE_API_KEY must be set',
    );

    return;
  }

  logger.info(
    { modelId, baseUrl, isAiEnabled: config.ai.isEnabled },
    'AI decisions are configured, document text will be sent to TypeSafe',
  );
}

function createLogMiddleware({
  logger,
  context,
}: {
  logger: Logger;
  context: Record<string, unknown>;
}): ChatMiddleware {
  return {
    name: 'log',
    onChunk: (_ctx, chunk) => {
      if (chunk.type === EventType.RUN_ERROR) {
        logger.error(
          {
            error: {
              message: chunk.message,
              code: chunk.code,
            },
            ...context,
          },
          'Error generating structured data',
        );
      }
    },
  };
}
