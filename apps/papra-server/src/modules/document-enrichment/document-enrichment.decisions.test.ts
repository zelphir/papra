import * as v from 'valibot';
import { describe, expect, test, vi } from 'vitest';
import type { AiServices } from '../ai/ai.services';
import { createInMemoryDatabase } from '../app/database/database.test-utils';
import { createTestEventServices } from '../app/events/events.test-utils';
import { buildApplyAutoTaggingActions } from '../auto-tagging/auto-tagging.usecases';
import { overrideConfig } from '../config/config.test-utils';
import { createCustomPropertiesRepository } from '../custom-properties/custom-properties.repository';
import { createCustomPropertiesOptionsRepository } from '../custom-properties/options/custom-properties-options.repository';
import { createDocumentsRepository } from '../documents/documents.repository';
import { createOrganizationsRepository } from '../organizations/organizations.repository';
import type { ResolveOrganizationSettingsUsecase } from '../organizations/organization-settings/organization-settings.usecases';
import { createTestLogger } from '../shared/logger/logger.test-utils';
import { createTagsRepository } from '../tags/tags.repository';
import { documentsTagsTable } from '../tags/tags.table';
import { applyTagsToDocuments, createTag } from '../tags/tags.usecases';
import { buildEnrichDocument } from './document-enrichment.usecases';
import { MAX_DECISION_CONTENT_LENGTH } from './document-enrichment.models';
import { DECISION_NO_THRESHOLD, DECISION_YES_THRESHOLD } from './document-enrichment.decisions';
import { buildCustomPropertiesEnrichmentCapability } from './enrichment-capabilities/custom-properties/custom-properties.enrichment-capability';
import { buildTagsEnrichmentCapability } from './enrichment-capabilities/tags/tags.enrichment-capability';
import { buildTitleEnrichmentCapability } from './enrichment-capabilities/title/title.enrichment-capability';

const documentIds = { documentId: 'doc_1', organizationId: 'org_1' };

const optionId = (index: number) => `cpso_${String(index).padStart(24, '0')}`;

const bool = (probability: number) => ({
  type: 'boolean' as const,
  value: probability >= 0.5,
  probability,
});
const pick = (option: number | 'none', probability: number) => ({
  type: 'choice' as const,
  value: option === 'none' ? 'none' : `option_${option}`,
  probability,
  confidence: 1,
  probabilities: {},
});

type Answers = Record<string, ReturnType<typeof bool> | ReturnType<typeof pick>>;

const propertyDefinition = (id: string, key: string, type: string, displayOrder: number) => ({
  id,
  displayOrder,
  organizationId: 'org_1',
  name: key,
  key,
  type: type as 'text',
  description: `The ${key}`,
});

// Property question positions follow this order: paid (0), category (1), then the text property that is never asked
const properties = [
  propertyDefinition('cpd_paid', 'paid', 'boolean', 0),
  propertyDefinition('cpd_category', 'category', 'select', 1),
  propertyDefinition('cpd_reference', 'reference', 'text', 2),
];

async function createTestDeps({
  isConfigured = true,
  withText = false,
  tagNames = ['Finance', 'Household'],
  canCreateNewTags = false,
  maxTags = 5,
  content = 'Electricity bill INV-42, paid in full',
  categoryOptions = ['Invoice', 'Quote'],
  answers = {} as Answers,
  decideError = undefined as Error | undefined,
  languageModelResponse = {} as Record<string, unknown>,
} = {}) {
  const { db } = await createInMemoryDatabase({
    organizations: [{ id: 'org_1', name: 'Org 1' }],
    documents: [
      {
        id: 'doc_1',
        organizationId: 'org_1',
        name: 'SCAN_0001.pdf',
        originalName: 'SCAN_0001.pdf',
        originalStorageKey: 'doc_1',
        originalSha256Hash: 'doc_1',
        mimeType: 'application/pdf',
        content,
      },
    ],
    tags: tagNames.map((name, index) => ({
      id: `tag_${index}`,
      organizationId: 'org_1',
      name,
      description: index === 0 ? 'Money matters' : undefined,
      normalizedName: name.toLowerCase(),
      color: '#000000',
      // Tags are listed newest first
      createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000),
    })),
    customPropertyDefinitions: withText ? properties : properties.slice(0, 2),
    customPropertySelectOptions: categoryOptions.map((name, index) => ({
      id: optionId(index),
      displayOrder: index,
      propertyDefinitionId: 'cpd_category',
      name,
      key: name.toLowerCase(),
    })),
  });
  const config = overrideConfig({
    ai: { isEnabled: true },
    autoTagging: { isEnabled: true },
    documentEnrichment: {
      titles: { isEnabled: true },
      dates: { isEnabled: false },
      customProperties: { isEnabled: true },
    },
  });
  const resolveOrganizationSettings: ResolveOrganizationSettingsUsecase = async () => ({
    organizationSettings: {
      ai: { autoTagging: { isEnabled: true, canCreateNewTags, maxTags, modelId: 'gpt-4' } },
    },
  });
  const documentsRepository = createDocumentsRepository({ db });
  const tagsRepository = createTagsRepository({ db });
  const customPropertiesRepository = createCustomPropertiesRepository({ db });
  const eventServices = createTestEventServices();
  const { logger, getLogs } = createTestLogger();

  // Validates the raw reply against the request schema, as the real library does
  const generateStructuredData = vi
    .fn<AiServices['generateStructuredData']>()
    .mockImplementation(async ({ schema }) => v.parse(schema!, languageModelResponse) as never);

  // Questions without a given answer are unclear
  const decide = vi.fn(async ({ questions }: { questions: Record<string, { type: string }> }) => {
    if (decideError) {
      throw decideError;
    }

    return {
      ...Object.fromEntries(
        Object.entries(questions).map(([key, question]) => [
          key,
          answers[key] ?? (question.type === 'choice' ? pick(0, 0.5) : bool(0.5)),
        ]),
      ),
      meta: {},
    };
  });

  const enrichDocument = buildEnrichDocument({
    config,
    documentsRepository,
    tagsRepository,
    customPropertiesRepository,
    organizationsRepository: createOrganizationsRepository({ db }),
    resolveOrganizationSettings,
    logger,
    aiServices: {
      generateStructuredData,
      decide,
      isDecisionModelConfigured: isConfigured,
    } as unknown as AiServices,
    capabilityDefinitions: [
      buildTagsEnrichmentCapability({
        config,
        applyAutoTaggingActions: buildApplyAutoTaggingActions({
          createTag: async (args) => createTag({ ...args, config, tagsRepository }),
          applyTagsToDocuments: async (args) =>
            applyTagsToDocuments({ ...args, tagsRepository, eventServices, logger }),
        }),
      }),
      buildTitleEnrichmentCapability({ config, documentsRepository, eventServices }),
      buildCustomPropertiesEnrichmentCapability({
        config,
        documentsRepository,
        customPropertiesRepository,
        customPropertiesOptionsRepository: createCustomPropertiesOptionsRepository({ db }),
        organizationsRepository: createOrganizationsRepository({ db }),
        logger,
      }),
    ],
  });

  return {
    enrichDocument,
    decide,
    generateStructuredData,
    customPropertiesRepository,
    getLogs,
    getQuestionKeys: () => Object.keys(decide.mock.calls[0]?.[0].questions ?? {}),
    getSchemaKeys: () =>
      Object.keys(
        (
          generateStructuredData.mock.calls[0]![0].schema as v.ObjectSchema<
            v.ObjectEntries,
            undefined
          >
        ).entries,
      ),
    getTagIds: async () =>
      (await db.select().from(documentsTagsTable)).map(({ tagId }) => tagId).sort(),
    getName: async () => (await documentsRepository.getDocumentById(documentIds)).document?.name,
    getValues: async () => {
      const { values } = await customPropertiesRepository.getDocumentCustomPropertyValues({
        documentId: 'doc_1',
      });
      return Object.fromEntries(
        values.map(({ value, option }) => [
          value.propertyDefinitionId,
          value.booleanValue ?? option?.name,
        ]),
      );
    },
  };
}

const confidentYes = DECISION_YES_THRESHOLD + 0.05;
const confidentNo = DECISION_NO_THRESHOLD - 0.05;

describe('document enrichment decisions', () => {
  describe('when the decision model is not configured', () => {
    test('it is never called and the language model gets every capability', async () => {
      const deps = await createTestDeps({ isConfigured: false });

      await deps.enrichDocument(documentIds);

      expect(deps.decide).not.toHaveBeenCalled();
      expect(deps.generateStructuredData).toHaveBeenCalledTimes(1);
      expect(deps.getSchemaKeys()).toEqual(['existingTags', 'title', 'customProperties']);
      const [request] = deps.generateStructuredData.mock.calls[0]!;
      expect(request.systemPrompt).toContain('DOCUMENT TAGS');
      expect(request.systemPrompt).toContain('DOCUMENT TITLE');
      expect(request.systemPrompt).toContain('"key":"paid"');
      expect(request.systemPrompt).toContain('"key":"category"');
      expect(
        (JSON.parse(request.userPrompt) as { existingTags: unknown[] }).existingTags,
      ).toHaveLength(2);
    });
  });

  describe('when the decision model settles everything', () => {
    const settledAnswers: Answers = {
      title__clear: bool(confidentYes),
      auto_tagging__tag_0: bool(confidentYes),
      auto_tagging__tag_1: bool(confidentNo),
      custom_properties__property_0: bool(confidentYes),
      custom_properties__property_1: pick(1, confidentYes),
    };

    test('no language model call is made and the decided values are written', async () => {
      const deps = await createTestDeps({ answers: settledAnswers });

      await deps.enrichDocument(documentIds);

      expect(deps.decide).toHaveBeenCalledTimes(1);
      expect(deps.generateStructuredData).not.toHaveBeenCalled();
      expect(await deps.getTagIds()).toEqual(['tag_0']);
      expect(await deps.getName()).toEqual('SCAN_0001.pdf');
      expect(await deps.getValues()).toEqual({ cpd_paid: true, cpd_category: 'Quote' });
    });

    test('a text property still goes to the language model', async () => {
      const deps = await createTestDeps({
        withText: true,
        answers: settledAnswers,
        languageModelResponse: { customProperties: { reference: 'INV-42' } },
      });

      await deps.enrichDocument(documentIds);

      expect(deps.getSchemaKeys()).toEqual(['customProperties']);
      expect(await deps.getValues()).toEqual({ cpd_paid: true, cpd_category: 'Quote' });
    });
  });

  describe('when the decision model settles only some of the questions', () => {
    test('the language model only gets what is left and both sets of values are written', async () => {
      const deps = await createTestDeps({
        withText: true,
        answers: {
          title__clear: bool(confidentYes),
          custom_properties__property_0: bool(confidentYes),
          // category is unclear, tags are unclear
        },
        languageModelResponse: {
          existingTags: ['Household'],
          customProperties: { category: 'Invoice', reference: 'INV-42' },
        },
      });

      await deps.enrichDocument(documentIds);

      expect(deps.getSchemaKeys()).toEqual(['existingTags', 'customProperties']);
      const [request] = deps.generateStructuredData.mock.calls[0]!;
      expect(request.systemPrompt).not.toContain('DOCUMENT TITLE');
      expect(request.systemPrompt).not.toContain('"key":"paid"');
      expect(request.systemPrompt).toContain('"key":"category"');
      expect(request.systemPrompt).toContain('"key":"reference"');
      expect(
        Object.keys(
          (
            (request.schema as v.ObjectSchema<v.ObjectEntries, undefined>).entries
              .customProperties as unknown as v.ObjectSchema<v.ObjectEntries, undefined>
          ).entries,
        ),
      ).toEqual(['category', 'reference']);
      expect(await deps.getTagIds()).toEqual(['tag_1']);
      expect(await deps.getValues()).toEqual({ cpd_paid: true, cpd_category: 'Invoice' });
      expect(await deps.getName()).toEqual('SCAN_0001.pdf');
    });
  });

  describe('when the decision model fails', () => {
    test.each([
      ['rejects', new Error('boom')],
      ['times out', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ])(
      'a decision that %s leaves everything to the language model and logs a warning',
      async (_, decideError) => {
        const deps = await createTestDeps({
          withText: true,
          decideError,
          languageModelResponse: {
            existingTags: ['Finance'],
            title: null,
            customProperties: { paid: true, category: 'Quote', reference: null },
          },
        });

        await deps.enrichDocument(documentIds);

        expect(deps.getSchemaKeys()).toEqual(['existingTags', 'title', 'customProperties']);
        expect(await deps.getTagIds()).toEqual(['tag_0']);
        expect(await deps.getValues()).toEqual({ cpd_paid: true, cpd_category: 'Quote' });
        const warnings = deps
          .getLogs({ excludeTimestampMs: true })
          .filter(({ level }) => level === 'warn');
        expect(warnings).toHaveLength(1);
        expect(JSON.stringify(warnings)).not.toContain('boom');
      },
    );
  });

  describe('title', () => {
    test('a filename the model finds clear is not renamed and no title is requested', async () => {
      const deps = await createTestDeps({ answers: { title__clear: bool(confidentYes) } });

      await deps.enrichDocument(documentIds);

      expect(deps.getSchemaKeys()).not.toContain('title');
      expect(await deps.getName()).toEqual('SCAN_0001.pdf');
    });

    test('an unclear answer keeps the title in the language model request', async () => {
      const deps = await createTestDeps({ answers: { title__clear: bool(0.6) } });

      await deps.enrichDocument(documentIds);

      expect(deps.getSchemaKeys()).toContain('title');
    });
  });

  describe('tags', () => {
    test('the tags the model is confident about are applied, highest probability first and capped at the maximum', async () => {
      const deps = await createTestDeps({
        tagNames: ['Finance', 'Household', 'Energy', 'Travel'],
        maxTags: 2,
        answers: {
          auto_tagging__tag_0: bool(0.92),
          auto_tagging__tag_1: bool(0.99),
          auto_tagging__tag_2: bool(0.95),
          auto_tagging__tag_3: bool(confidentNo),
        },
      });

      await deps.enrichDocument(documentIds);

      expect(await deps.getTagIds()).toEqual(['tag_1', 'tag_2']);
      expect(deps.getSchemaKeys()).not.toContain('existingTags');
    });

    test('a single unclear answer sends all tagging to the language model and the other answers are ignored', async () => {
      const deps = await createTestDeps({
        answers: { auto_tagging__tag_0: bool(confidentYes), auto_tagging__tag_1: bool(0.5) },
        languageModelResponse: { existingTags: ['Household'] },
      });

      await deps.enrichDocument(documentIds);

      expect(deps.getSchemaKeys()).toContain('existingTags');
      expect(await deps.getTagIds()).toEqual(['tag_1']);
    });

    test('no tag question is asked when new tags can be created', async () => {
      const deps = await createTestDeps({ canCreateNewTags: true });

      await deps.enrichDocument(documentIds);

      expect(deps.getQuestionKeys().filter((key) => key.startsWith('auto_tagging__'))).toEqual([]);
      expect(deps.getSchemaKeys()).toContain('existingTags');
    });

    test('no tag question is asked above 100 tags', async () => {
      const deps = await createTestDeps({
        tagNames: Array.from({ length: 101 }, (_, index) => `Tag ${index}`),
      });

      await deps.enrichDocument(documentIds);

      expect(deps.getQuestionKeys().filter((key) => key.startsWith('auto_tagging__'))).toEqual([]);
    });

    test('tag names such as meta or with odd characters never end up in question keys', async () => {
      const deps = await createTestDeps({
        tagNames: ['meta', 'a.b "c" \u{1F600} {x}'],
        answers: {
          auto_tagging__tag_0: bool(confidentYes),
          auto_tagging__tag_1: bool(confidentYes),
        },
      });

      await deps.enrichDocument(documentIds);

      expect(deps.getQuestionKeys().filter((key) => key.startsWith('auto_tagging__'))).toEqual([
        'auto_tagging__tag_0',
        'auto_tagging__tag_1',
      ]);
      expect(deps.getQuestionKeys()).not.toContain('meta');
      expect(await deps.getTagIds()).toEqual(['tag_0', 'tag_1']);
    });
  });

  describe('properties', () => {
    test('a clear no on a boolean property writes nothing and leaves it to the language model, since the document may simply not mention it', async () => {
      const deps = await createTestDeps({
        answers: { custom_properties__property_0: bool(confidentNo) },
        languageModelResponse: {
          customProperties: { paid: null, category: null, reference: null },
        },
      });

      await deps.enrichDocument(documentIds);

      expect(deps.generateStructuredData.mock.calls[0]![0].systemPrompt).toContain('"key":"paid"');
      expect(await deps.getValues()).toEqual({});
    });

    test('a boolean property is set to true only on a clear yes', async () => {
      const unclear = await createTestDeps({
        answers: { custom_properties__property_0: bool(0.5) },
        languageModelResponse: {
          customProperties: { paid: null, category: null, reference: null },
        },
      });
      await unclear.enrichDocument(documentIds);

      expect(unclear.getSchemaKeys()).toContain('customProperties');
      expect(await unclear.getValues()).toEqual({});

      const clearYes = await createTestDeps({
        answers: { custom_properties__property_0: bool(confidentYes) },
        languageModelResponse: { customProperties: { category: null, reference: null } },
      });
      await clearYes.enrichDocument(documentIds);

      expect(await clearYes.getValues()).toEqual({ cpd_paid: true });
    });

    test('a select property is set to the picked option only on a clear pick, an unclear one goes to the language model', async () => {
      const clear = await createTestDeps({
        answers: { custom_properties__property_1: pick(0, confidentYes) },
        languageModelResponse: { customProperties: { paid: null, reference: null } },
      });
      await clear.enrichDocument(documentIds);

      expect(await clear.getValues()).toEqual({ cpd_category: 'Invoice' });
      expect(clear.generateStructuredData.mock.calls[0]![0].systemPrompt).not.toContain(
        '"key":"category"',
      );

      const unclear = await createTestDeps({
        answers: { custom_properties__property_1: pick(0, 0.6) },
        languageModelResponse: {
          customProperties: { paid: null, category: 'Quote', reference: null },
        },
      });
      await unclear.enrichDocument(documentIds);

      expect(await unclear.getValues()).toEqual({ cpd_category: 'Quote' });
    });

    test('a clear none leaves the select empty and it is not asked to the language model', async () => {
      const deps = await createTestDeps({
        answers: { custom_properties__property_1: pick('none', confidentYes) },
        languageModelResponse: { customProperties: { paid: null, reference: null } },
      });

      await deps.enrichDocument(documentIds);

      expect(await deps.getValues()).toEqual({});
      expect(deps.generateStructuredData.mock.calls[0]![0].systemPrompt).not.toContain(
        '"key":"category"',
      );
    });

    test('a value set while the run was in progress is preserved', async () => {
      const deps = await createTestDeps({
        answers: { custom_properties__property_1: pick(0, confidentYes) },
        languageModelResponse: { customProperties: { paid: null, reference: null } },
      });
      const decide = deps.decide.getMockImplementation();
      deps.decide.mockImplementationOnce(async (args) => {
        await deps.customPropertiesRepository.setDocumentCustomPropertyValue({
          documentId: 'doc_1',
          propertyDefinitionId: 'cpd_category',
          values: [{ selectOptionId: optionId(1) }],
        });
        return decide!(args);
      });

      await deps.enrichDocument(documentIds);

      expect(await deps.getValues()).toEqual({ cpd_category: 'Quote' });
    });

    test('a select with 254 options is asked, since the none option brings it to the 255 option limit', async () => {
      const deps = await createTestDeps({
        categoryOptions: Array.from({ length: 254 }, (_, index) => `Opt${index}`),
      });

      await deps.enrichDocument(documentIds);

      expect(deps.getQuestionKeys()).toContain('custom_properties__property_1');
    });

    test('question keys only use letters, digits and underscores', async () => {
      const deps = await createTestDeps();

      await deps.enrichDocument(documentIds);

      expect(deps.getQuestionKeys().length).toBeGreaterThan(0);
      expect(deps.getQuestionKeys().filter((key) => !/^\w+$/.test(key))).toEqual([]);
    });

    test('no question is asked for a select with more than 254 options', async () => {
      const deps = await createTestDeps({
        categoryOptions: Array.from({ length: 255 }, (_, index) => `Opt${index}`),
      });

      await deps.enrichDocument(documentIds);

      expect(deps.getQuestionKeys()).not.toContain('custom_properties__property_1');
      expect(deps.generateStructuredData.mock.calls[0]![0].systemPrompt).toContain(
        '"key":"category"',
      );
    });
  });

  describe('state sent to the decision model', () => {
    test('it only holds the filename and a capped content, without tags or property values', async () => {
      const deps = await createTestDeps({ content: 'x'.repeat(50_000) });

      await deps.enrichDocument(documentIds);

      const { state } = deps.decide.mock.calls[0]![0] as unknown as {
        state: { name: string; content: string };
      };
      expect(Object.keys(state).sort()).toEqual(['content', 'name']);
      expect(state.name).toEqual('SCAN_0001.pdf');
      expect(state.content.length).toBeLessThanOrEqual(MAX_DECISION_CONTENT_LENGTH);
      expect(JSON.stringify(state)).not.toContain('Finance');
    });
  });
});
