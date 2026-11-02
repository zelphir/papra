import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { boolean, choice, score } from '@tanstack/ai';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createInMemoryDatabase } from '../app/database/database.test-utils';
import { createAiCreditsRepository } from '../ai-credits/ai-credits.repository';
import { organizationAiCreditsUsageTable } from '../ai-credits/ai-credits.tables';
import { overrideConfig } from '../config/config.test-utils';
import { createPlanEntitlementDefinitionRegistry } from '../plan-entitlements/plan-entitlements.registry';
import { createPlanEntitlementsRepository } from '../plan-entitlements/plan-entitlements.repository';
import { createPlansRepository } from '../plans/plans.repository';
import { createTestLogger } from '../shared/logger/logger.test-utils';
import { createSubscriptionsRepository } from '../subscriptions/subscriptions.repository';
import { createAiServices, logDecisionModelConfiguration } from './ai.services';

// Only 'jev-latest' is priced, to test both a priced and an unpriced decision model
vi.mock('../ai-credits/rates/ai-credits.rates', () => ({
  modelCreditRates: {
    'typesafe://jev-latest': {
      creditsPerMillionInputTokens: 1_000_000,
      creditsPerMillionOutputTokens: 1_000_000,
    },
  },
}));

const API_KEY = 'ts-secret-api-key';

// The wire shape comes from @tanstack/ai-typesafe (dist/esm/adapters/evaluate.js): POST /v1/systemone
// answers `{ model, answers, usage: { input_tokens, output_tokens } }`. It is an assumption about the real API.
const jevResponse = {
  model: 'jev-1.13.0',
  usage: { input_tokens: 120, output_tokens: 3 },
  answers: {
    queue: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.82, tech: 0.18 },
      confidence: 0.9,
    },
    urgency: {
      type: 'score',
      score: 1.2,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 },
      confidence: 0.7,
    },
    refund: { type: 'noul', noul: 0.91 },
  },
};

const questions = {
  queue: choice({ instructions: 'Which queue?', options: { billing: 'Payments', tech: 'Bugs' } }),
  urgency: score({ instructions: 'How urgent?', levels: ['low', 'medium', 'high'] }),
  refund: boolean({ instructions: 'Is a refund requested?' }),
};

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function startFakeTypesafeServer({
  status = 200,
  body = jevResponse,
}: { status?: number; body?: unknown } = {}) {
  const requests: { url?: string; authorization?: string; body: any }[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function createTestAiServices({
  decisions = { modelId: 'jev-latest', apiKey: API_KEY },
  isAiEnabled = true,
  isCreditsEnabled = false,
}: {
  decisions?: { modelId?: string; apiKey?: string; baseUrl?: string };
  isAiEnabled?: boolean;
  isCreditsEnabled?: boolean;
} = {}) {
  const { db } = await createInMemoryDatabase({
    organizations: [{ id: 'organization-1', name: 'Organization 1' }],
  });
  const config = overrideConfig({
    ai: { isEnabled: isAiEnabled, credits: { isEnabled: isCreditsEnabled }, decisions },
    organizationPlans: { isFreePlanUnlimited: false },
  });
  const aiCreditsRepository = createAiCreditsRepository({ db });
  const { logger, getLogs } = createTestLogger();

  const aiServices = createAiServices({
    config,
    logger,
    aiCreditsRepository,
    plansRepository: createPlansRepository({ config }),
    planEntitlementDefinitionRegistry: createPlanEntitlementDefinitionRegistry({ config }),
    planEntitlementsRepository: createPlanEntitlementsRepository({ db }),
    subscriptionsRepository: createSubscriptionsRepository({ db }),
  });

  const getUsages = async () => db.select().from(organizationAiCreditsUsageTable);

  return { aiServices, aiCreditsRepository, getLogs, getUsages };
}

const decideArgs = {
  state: { subject: 'Where is my invoice?' },
  questions,
  source: 'decision',
  organizationId: 'organization-1',
} as const;

describe('ai services', () => {
  describe('decide', () => {
    describe('configuration', () => {
      test('when no decision model is configured, decisions are off and decide throws without any network call', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const { aiServices } = await createTestAiServices({ decisions: {} });

        expect(aiServices.isDecisionModelConfigured).to.eql(false);
        await expect(aiServices.decide(decideArgs)).rejects.toMatchObject({
          code: 'ai.decision_model_not_configured',
          isInternal: true,
        });
        expect(fetchSpy).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
      });

      test.each([
        [
          'AI is disabled',
          { isAiEnabled: false, decisions: { modelId: 'jev-latest', apiKey: API_KEY } },
        ],
        ['only the model is set', { decisions: { modelId: 'jev-latest', apiKey: '' } }],
        ['only the api key is set', { decisions: { apiKey: API_KEY } }],
      ])('decisions are not configured when %s', async (_, options) => {
        const { aiServices } = await createTestAiServices(options);

        expect(aiServices.isDecisionModelConfigured).to.eql(false);
      });

      test('decisions are configured when AI is enabled and both the model and the api key are set', async () => {
        const { aiServices } = await createTestAiServices();

        expect(aiServices.isDecisionModelConfigured).to.eql(true);
      });
    });

    test('a decision is requested at the configured base url with the api key, and typed answers with probabilities come back', async () => {
      const { requests, baseUrl } = await startFakeTypesafeServer();
      const { aiServices } = await createTestAiServices({
        decisions: { modelId: 'jev-latest', apiKey: API_KEY, baseUrl },
      });

      const result = await aiServices.decide(decideArgs);

      expect(requests).to.have.length(1);
      expect(requests[0]?.url).to.eql('/v1/systemone');
      expect(requests[0]?.authorization).to.eql(`Bearer ${API_KEY}`);
      expect(requests[0]?.body.model).to.eql('jev-latest');
      expect(requests[0]?.body.state).to.eql({ subject: 'Where is my invoice?' });

      expect(result.queue.value).to.eql('billing');
      expect(result.queue.probability).to.eql(0.82);
      expect(result.urgency.value).to.eql('medium');
      expect(result.urgency.probability).to.eql(0.7);
      expect(result.refund.value).to.eql(true);
      expect(result.refund.probability).to.eql(0.91);
      expect(result.meta.usage.promptTokens).to.eql(120);
    });

    test('a decision that takes longer than 30 seconds is cancelled and rejects like any other failure', async () => {
      const server = createServer(() => {});
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { aiServices } = await createTestAiServices({
        decisions: { modelId: 'jev-latest', apiKey: API_KEY, baseUrl },
      });
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20));

      await expect(aiServices.decide(decideArgs)).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);

      timeoutSpy.mockRestore();
    });

    describe('ai credits', () => {
      test('when credits are enabled and the organization has exhausted its credits, the decision is blocked before any call', async () => {
        const { requests, baseUrl } = await startFakeTypesafeServer();
        const { aiServices, aiCreditsRepository } = await createTestAiServices({
          isCreditsEnabled: true,
          decisions: { modelId: 'jev-latest', apiKey: API_KEY, baseUrl },
        });
        await aiCreditsRepository.registerCreditConsumption({
          organizationId: 'organization-1',
          creditsConsumed: 1_000_000,
          source: 'auto-tagging',
          usage: {
            type: 'llm-model',
            modelId: 'x://y',
            inputTokens: 0,
            outputTokens: 0,
            creditsRate: { creditsPerMillionInputTokens: 0, creditsPerMillionOutputTokens: 0 },
          },
        });

        await expect(aiServices.decide(decideArgs)).rejects.toMatchObject({
          code: 'ai_credits.limit_exceeded',
        });
        expect(requests).to.have.length(0);
      });

      test('when credits are enabled, the usage reported by the decision is recorded for the organization with the decision source', async () => {
        const { baseUrl } = await startFakeTypesafeServer();
        const { aiServices, getUsages } = await createTestAiServices({
          isCreditsEnabled: true,
          decisions: { modelId: 'jev-latest', apiKey: API_KEY, baseUrl },
        });

        await aiServices.decide(decideArgs);

        const usages = await getUsages();
        expect(usages).to.have.length(1);
        expect(usages[0]).toMatchObject({
          organizationId: 'organization-1',
          source: 'decision',
          creditsConsumed: 123,
          usage: { modelId: 'typesafe://jev-latest', inputTokens: 120, outputTokens: 3 },
        });
      });

      test('when credits are disabled, no usage is recorded', async () => {
        const { baseUrl } = await startFakeTypesafeServer();
        const { aiServices, getUsages } = await createTestAiServices({
          decisions: { modelId: 'jev-latest', apiKey: API_KEY, baseUrl },
        });

        await aiServices.decide(decideArgs);

        expect(await getUsages()).to.eql([]);
      });

      test('when the decision model has no credit rate, the decision is still returned and the failure to record usage is logged', async () => {
        const { baseUrl } = await startFakeTypesafeServer();
        const { aiServices, getUsages, getLogs } = await createTestAiServices({
          isCreditsEnabled: true,
          decisions: { modelId: 'jev-unpriced', apiKey: API_KEY, baseUrl },
        });

        const result = await aiServices.decide(decideArgs);

        expect(result.queue.value).to.eql('billing');
        expect(await getUsages()).to.eql([]);
        expect(getLogs().map(({ message }) => message)).to.eql([
          'Failed to register AI credit usage',
        ]);
      });
    });

    describe('provider failures', () => {
      test('when the provider rejects the api key, the error keeps its 401 status and the log says the key was rejected without leaking it', async () => {
        const { baseUrl } = await startFakeTypesafeServer({
          status: 401,
          body: { error: 'unauthorized' },
        });
        const { aiServices, getLogs } = await createTestAiServices({
          decisions: { modelId: 'jev-latest', apiKey: API_KEY, baseUrl },
        });

        await expect(aiServices.decide(decideArgs)).rejects.toMatchObject({ status: 401 });

        const logs = getLogs({ excludeTimestampMs: true });
        expect(logs).to.eql([
          {
            level: 'error',
            message: 'TypeSafe rejected the API key (401), check TYPESAFE_API_KEY',
            namespace: 'test',
            data: { modelId: 'jev-latest', status: 401 },
          },
        ]);
        expect(JSON.stringify(logs)).not.toContain(API_KEY);
      });

      test('when the provider fails with a 500, the error keeps its status and the log carries the model and status only', async () => {
        const { baseUrl } = await startFakeTypesafeServer({
          status: 500,
          body: { error: 'document text echoed back' },
        });
        const { aiServices, getLogs } = await createTestAiServices({
          decisions: { modelId: 'jev-latest', apiKey: API_KEY, baseUrl },
        });

        await expect(aiServices.decide(decideArgs)).rejects.toMatchObject({ status: 500 });

        const logs = getLogs({ excludeTimestampMs: true });
        expect(logs).to.eql([
          {
            level: 'error',
            message: 'Error making AI decisions',
            namespace: 'test',
            data: { modelId: 'jev-latest', status: 500 },
          },
        ]);
        expect(JSON.stringify(logs)).not.toContain(API_KEY);
      });
    });
  });
});

describe('logDecisionModelConfiguration', () => {
  const log = (decisions: { modelId?: string; apiKey?: string }) => {
    const { logger, getLogs } = createTestLogger();
    logDecisionModelConfiguration({ config: overrideConfig({ ai: { decisions } }), logger });

    return getLogs({ excludeTimestampMs: true });
  };

  test('when decisions are not configured, nothing is logged', () => {
    expect(log({})).to.eql([]);
  });

  test('when both the model and the key are set, one info line is logged without the api key', () => {
    const logs = log({ modelId: 'jev-latest', apiKey: API_KEY });

    expect(logs.map(({ level }) => level)).to.eql(['info']);
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
  });

  test.each([{ modelId: 'jev-latest' }, { apiKey: API_KEY }])(
    'when only one of the model and the key is set, one warning is logged without the api key',
    (decisions) => {
      const logs = log(decisions);

      expect(logs.map(({ level }) => level)).to.eql(['warn']);
      expect(JSON.stringify(logs)).not.toContain(API_KEY);
    },
  );
});
