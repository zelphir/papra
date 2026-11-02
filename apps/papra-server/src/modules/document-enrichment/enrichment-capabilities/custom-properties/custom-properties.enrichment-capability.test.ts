import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { describe, expect, test, vi } from 'vitest';
import type { AiServices } from '../../../ai/ai.services';
import { createInMemoryDatabase } from '../../../app/database/database.test-utils';
import { createTestEventServices } from '../../../app/events/events.test-utils';
import { buildApplyAutoTaggingActions } from '../../../auto-tagging/auto-tagging.usecases';
import { overrideConfig } from '../../../config/config.test-utils';
import { createCustomPropertiesRepository } from '../../../custom-properties/custom-properties.repository';
import { createCustomPropertiesOptionsRepository } from '../../../custom-properties/options/custom-properties-options.repository';
import { createDocumentsRepository } from '../../../documents/documents.repository';
import { createOrganizationsRepository } from '../../../organizations/organizations.repository';
import type { ResolveOrganizationSettingsUsecase } from '../../../organizations/organization-settings/organization-settings.usecases';
import { createTestLogger } from '../../../shared/logger/logger.test-utils';
import { createTagsRepository } from '../../../tags/tags.repository';
import { documentsTagsTable } from '../../../tags/tags.table';
import { applyTagsToDocuments, createTag } from '../../../tags/tags.usecases';
import { createDocumentEnrichmentDisabledError } from '../../document-enrichment.errors';
import {
  buildEnrichDocument,
  buildScheduleDocumentEnrichment,
} from '../../document-enrichment.usecases';
import { buildDateEnrichmentCapability } from '../date/date.enrichment-capability';
import { buildTagsEnrichmentCapability } from '../tags/tags.enrichment-capability';
import { buildTitleEnrichmentCapability } from '../title/title.enrichment-capability';
import { getCustomPropertiesResponseSchema } from './custom-properties.models';
import { buildCustomPropertiesEnrichmentCapability } from './custom-properties.enrichment-capability';

const documentIds = { documentId: 'doc_1', organizationId: 'org_1' };

const resolveOrganizationSettings: ResolveOrganizationSettingsUsecase = async () => ({
  organizationSettings: {
    ai: {
      autoTagging: { isEnabled: true, canCreateNewTags: false, maxTags: 5, modelId: 'gpt-4' },
    },
  },
});

const definition = (id: string, key: string, type: string) => ({
  id,
  organizationId: 'org_1',
  name: key,
  key,
  type: type as 'text',
  description: `The ${key}`,
});

const properties = [
  definition('cpd_text', 'reference', 'text'),
  definition('cpd_number', 'amount', 'number'),
  definition('cpd_date', 'expiry', 'date'),
  definition('cpd_bool', 'paid', 'boolean'),
  definition('cpd_select', 'category', 'select'),
  definition('cpd_multi', 'topics', 'multi_select'),
  definition('cpd_user', 'owner', 'user_relation'),
  definition('cpd_doc', 'related', 'document_relation'),
  definition('cpd_empty', 'status', 'select'),
];

// Option ids must match the real id format
const optionId = (name: string) => `cpso_${name.toLowerCase().padEnd(24, '0')}`;

const option = (propertyDefinitionId: string, name: string) => ({
  id: optionId(name),
  propertyDefinitionId,
  name,
  key: name.toLowerCase(),
});

const fullResponse = {
  customProperties: {
    reference: 'INV-42',
    amount: 129.9,
    expiry: '2099-12-31',
    paid: true,
    category: 'Invoice',
    topics: ['Energy', 'Home'],
    owner: null,
    related: null,
    status: null,
  },
};

async function createTestDeps({
  isEnabled = true,
  response = fullResponse as Record<string, unknown>,
  withOthers = false,
  customPropertyDefinitions = properties,
  members = [] as { id: string; name: string | null; email: string }[],
  documentCustomPropertyValues = [] as {
    id: string;
    documentId: string;
    propertyDefinitionId: string;
    textValue?: string;
  }[],
} = {}) {
  const { db } = await createInMemoryDatabase({
    users: [{ id: 'user_1', email: 'user@example.com' }, ...members],
    organizations: [{ id: 'org_1', name: 'Org 1' }],
    ...(members.length > 0
      ? {
          organizationMembers: members.map(({ id }) => ({
            organizationId: 'org_1',
            userId: id,
            role: 'member' as const,
          })),
        }
      : {}),
    documents: [
      {
        id: 'doc_1',
        organizationId: 'org_1',
        name: 'SCAN_0001.pdf',
        originalName: 'SCAN_0001.pdf',
        originalStorageKey: 'doc_1',
        originalSha256Hash: 'doc_1',
        mimeType: 'application/pdf',
        content: 'Electricity bill INV-42 for 129.90 EUR',
      },
    ],
    tags: [
      {
        id: 'tag_1',
        organizationId: 'org_1',
        name: 'Finance',
        normalizedName: 'finance',
        color: '#000000',
      },
    ],
    customPropertyDefinitions,
    ...(customPropertyDefinitions.some(({ id }) => id === 'cpd_select')
      ? {
          customPropertySelectOptions: [
            option('cpd_select', 'Invoice'),
            option('cpd_select', 'Quote'),
            option('cpd_multi', 'Energy'),
            option('cpd_multi', 'Home'),
          ],
        }
      : {}),
    ...(documentCustomPropertyValues.length > 0 ? { documentCustomPropertyValues } : {}),
  });
  const config = overrideConfig({
    ai: { isEnabled: true },
    autoTagging: { isEnabled: true },
    documentEnrichment: {
      titles: { isEnabled: true },
      dates: { isEnabled: true },
      customProperties: { isEnabled },
    },
  });
  const documentsRepository = createDocumentsRepository({ db });
  const tagsRepository = createTagsRepository({ db });
  const customPropertiesRepository = createCustomPropertiesRepository({ db });
  const organizationsRepository = createOrganizationsRepository({ db });
  const eventServices = createTestEventServices();
  const { logger, getLogs } = createTestLogger();
  const generateStructuredData = vi
    .fn<AiServices['generateStructuredData']>()
    // Validates the raw reply against the request schema, as the real library does
    .mockImplementation(async ({ schema }) => v.parse(schema!, response) as never);

  const customPropertiesCapability = buildCustomPropertiesEnrichmentCapability({
    config,
    documentsRepository,
    customPropertiesRepository,
    customPropertiesOptionsRepository: createCustomPropertiesOptionsRepository({ db }),
    organizationsRepository,
    logger,
  });

  return {
    db,
    config,
    generateStructuredData,
    customPropertiesRepository,
    documentsRepository,
    organizationsRepository,
    getLogs,
    getValues: async () => {
      const { values } = await customPropertiesRepository.getDocumentCustomPropertyValues({
        documentId: 'doc_1',
      });
      return values;
    },
    enrichDocument: buildEnrichDocument({
      config,
      documentsRepository,
      tagsRepository,
      customPropertiesRepository,
      organizationsRepository,
      logger,
      resolveOrganizationSettings,
      aiServices: { generateStructuredData } as unknown as AiServices,
      capabilityDefinitions: withOthers
        ? [
            buildTagsEnrichmentCapability({
              config,
              applyAutoTaggingActions: buildApplyAutoTaggingActions({
                createTag: async (args) => createTag({ ...args, config, tagsRepository }),
                applyTagsToDocuments: async (args) =>
                  applyTagsToDocuments({ ...args, tagsRepository, eventServices, logger }),
              }),
            }),
            buildTitleEnrichmentCapability({ config, documentsRepository, eventServices }),
            buildDateEnrichmentCapability({ config, documentsRepository, eventServices }),
            customPropertiesCapability,
          ]
        : [customPropertiesCapability],
    }),
  };
}

describe('custom properties enrichment capability', () => {
  test('empty properties of every supported type are filled from the document, select values stored as option ids and dates as calendar days', async () => {
    const deps = await createTestDeps();

    await deps.enrichDocument(documentIds);

    const values = Object.fromEntries(
      (await deps.getValues()).map(({ value, option }) => [
        value.propertyDefinitionId,
        { ...value, optionName: option?.name },
      ]),
    );
    expect(values.cpd_text).toMatchObject({ textValue: 'INV-42' });
    expect(values.cpd_number).toMatchObject({ numberValue: 129.9 });
    expect(values.cpd_date).toMatchObject({ dateValue: new Date('2099-12-31T12:00:00.000Z') });
    expect(values.cpd_bool).toMatchObject({ booleanValue: true });
    expect(values.cpd_select).toMatchObject({ selectOptionId: optionId('Invoice') });
    expect(
      (await deps.getValues())
        .filter(({ value }) => value.propertyDefinitionId === 'cpd_multi')
        .map(({ value }) => value.selectOptionId)
        .sort((a, b) => a!.localeCompare(b!)),
    ).toEqual([optionId('Energy'), optionId('Home')]);
    expect(Object.keys(values)).toHaveLength(6);
  });

  test('the prompt lists only fillable properties with their options and the schema has one nullable required entry per property', async () => {
    const deps = await createTestDeps();

    await deps.enrichDocument(documentIds);

    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).toContain('CUSTOM PROPERTIES');
    expect(request.systemPrompt).toContain(
      '"key":"category","name":"category","description":"The category","type":"select","options":["Invoice","Quote"]',
    );
    expect(request.systemPrompt).not.toContain('"key":"owner"');
    expect(request.systemPrompt).not.toContain('"key":"related"');
    expect(request.systemPrompt).not.toContain('"key":"status"');
    // Required but nullable: an empty or missing answer falls back to abstaining, an abstention is accepted
    const { schema } = request;
    expect(v.parse(schema!, { customProperties: {} })).toMatchObject({
      customProperties: {
        reference: null,
        topics: null,
      },
    });
    expect(
      v.safeParse(schema!, {
        customProperties: Object.fromEntries(
          ['reference', 'amount', 'expiry', 'paid', 'category', 'topics'].map((key) => [key, null]),
        ),
      }).success,
    ).toBe(true);
  });

  test('the response schema converts to a JSON schema', async () => {
    const deps = await createTestDeps();
    const { definitions } = await (async () => {
      const { propertyDefinitions } =
        await deps.customPropertiesRepository.getOrganizationPropertyDefinitions({
          organizationId: 'org_1',
        });
      return { definitions: propertyDefinitions.filter(({ id }) => id !== 'cpd_empty') };
    })();

    const schema = getCustomPropertiesResponseSchema({
      properties: definitions.filter(({ type }) => !type.endsWith('relation')),
      members: [],
    });
    const jsonSchema = toStandardJsonSchema(schema)['~standard'].jsonSchema.input({
      target: 'draft-07',
    });

    expect(jsonSchema).toMatchObject({
      type: 'object',
      required: ['customProperties'],
      properties: {
        customProperties: {
          required: expect.arrayContaining([
            'reference',
            'amount',
            'expiry',
            'paid',
            'category',
            'topics',
          ]),
          properties: {
            category: { anyOf: [{ enum: ['Invoice', 'Quote'] }, { type: 'null' }] },
            topics: {
              anyOf: [{ type: 'array', items: { enum: ['Energy', 'Home'] } }, { type: 'null' }],
            },
          },
        },
      },
    });
  });

  test('when disabled, nothing is added to the prompt or schema, no property is queried and the AI is not called', async () => {
    const deps = await createTestDeps({ isEnabled: false, withOthers: true });
    const definitionsQuery = vi.spyOn(
      deps.customPropertiesRepository,
      'getOrganizationPropertyDefinitions',
    );
    const valuesQuery = vi.spyOn(
      deps.customPropertiesRepository,
      'getDocumentCustomPropertyValues',
    );

    await deps.enrichDocument(documentIds);

    expect(definitionsQuery).not.toHaveBeenCalled();
    expect(valuesQuery).not.toHaveBeenCalled();
    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).not.toContain('CUSTOM PROPERTIES');
    expect(
      Object.keys((request.schema as v.ObjectSchema<v.ObjectEntries, undefined>).entries),
    ).not.toContain('customProperties');
    expect(await deps.getValues()).toEqual([]);
  });

  test('a property that already has a value is never changed nor asked to the model', async () => {
    const deps = await createTestDeps({
      documentCustomPropertyValues: [
        { id: 'dcpv_1', documentId: 'doc_1', propertyDefinitionId: 'cpd_text', textValue: 'MINE' },
      ],
    });

    await deps.enrichDocument(documentIds);

    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).not.toContain('"key":"reference"');
    expect(
      (await deps.getValues()).find(({ value }) => value.propertyDefinitionId === 'cpd_text')?.value
        .textValue,
    ).toEqual('MINE');
  });

  test('null means no change', async () => {
    const deps = await createTestDeps({
      response: {
        customProperties: {
          ...fullResponse.customProperties,
          reference: null,
          amount: null,
          expiry: null,
          paid: null,
          category: null,
          topics: null,
        },
      },
    });

    await deps.enrichDocument(documentIds);

    expect(await deps.getValues()).toEqual([]);
  });

  test('a value set by the user while the AI was running is preserved', async () => {
    const deps = await createTestDeps();
    deps.generateStructuredData.mockImplementation(async () => {
      await deps.customPropertiesRepository.setDocumentCustomPropertyValue({
        documentId: 'doc_1',
        propertyDefinitionId: 'cpd_text',
        values: [{ textValue: 'MINE' }],
      });
      return fullResponse;
    });

    await deps.enrichDocument(documentIds);

    const values = await deps.getValues();
    expect(
      values.find(({ value }) => value.propertyDefinitionId === 'cpd_text')?.value.textValue,
    ).toEqual('MINE');
    expect(
      values.find(({ value }) => value.propertyDefinitionId === 'cpd_number')?.value.numberValue,
    ).toEqual(129.9);
  });

  test('a document trashed while the AI was running gets no value', async () => {
    const deps = await createTestDeps();
    deps.generateStructuredData.mockImplementation(async () => {
      await deps.documentsRepository.softDeleteDocument({ ...documentIds, userId: 'user_1' });
      return fullResponse;
    });

    await deps.enrichDocument(documentIds);

    expect(await deps.getValues()).toEqual([]);
  });

  test('a select value outside the options is never written, and invalid values do not block valid ones', async () => {
    const deps = await createTestDeps({
      response: {
        customProperties: {
          ...fullResponse.customProperties,
          category: 'Receipt',
          topics: ['Unknown'],
          amount: 'a lot',
          expiry: '2026-02-30',
        },
      },
    });

    await deps.enrichDocument(documentIds);

    const filled = [
      ...new Set((await deps.getValues()).map(({ value }) => value.propertyDefinitionId)),
    ].sort();
    expect(filled).toEqual(['cpd_bool', 'cpd_text']);
  });

  test('a property whose definition is deleted while the AI runs is skipped and the others are still written', async () => {
    const deps = await createTestDeps();
    const getPropertyDefinitionById = deps.customPropertiesRepository.getPropertyDefinitionById;
    vi.spyOn(deps.customPropertiesRepository, 'getPropertyDefinitionById').mockImplementation(
      async (args) =>
        args.propertyDefinitionId === 'cpd_number'
          ? { definition: undefined }
          : getPropertyDefinitionById(args),
    );

    await deps.enrichDocument(documentIds);

    const filled = [
      ...new Set((await deps.getValues()).map(({ value }) => value.propertyDefinitionId)),
    ].sort();
    expect(filled).toEqual(['cpd_bool', 'cpd_date', 'cpd_multi', 'cpd_select', 'cpd_text']);
  });

  test('a reply without the custom properties changes nothing and does not fail', async () => {
    const deps = await createTestDeps({ response: {} });

    await deps.enrichDocument(documentIds);

    expect(await deps.getValues()).toEqual([]);
  });

  test('a reply with invalid fields still applies the valid tags, title, date and properties', async () => {
    const deps = await createTestDeps({
      withOthers: true,
      response: {
        existingTags: ['Unknown'],
        title: 'Electricity bill',
        documentDate: '2024-03-15',
        customProperties: {
          ...fullResponse.customProperties,
          category: 'Receipt',
          amount: '1,200',
          paid: 'yes',
        },
      },
    });

    await deps.enrichDocument(documentIds);

    expect(await deps.db.select().from(documentsTagsTable)).toEqual([]);
    expect((await deps.documentsRepository.getDocumentById(documentIds)).document).toMatchObject({
      name: 'Electricity bill.pdf',
      documentDate: new Date('2024-03-15T12:00:00.000Z'),
    });
    const filled = [
      ...new Set((await deps.getValues()).map(({ value }) => value.propertyDefinitionId)),
    ].sort();
    expect(filled).toEqual(['cpd_date', 'cpd_multi', 'cpd_text']);
  });

  test('a reply without a title keeps the document name and still applies the other fields', async () => {
    const deps = await createTestDeps({
      withOthers: true,
      response: { existingTags: ['Finance'], documentDate: '2024-03-15', ...fullResponse },
    });

    await deps.enrichDocument(documentIds);

    expect((await deps.documentsRepository.getDocumentById(documentIds)).document).toMatchObject({
      name: 'SCAN_0001.pdf',
      documentDate: new Date('2024-03-15T12:00:00.000Z'),
    });
    expect(await deps.db.select().from(documentsTagsTable)).toHaveLength(1);
  });

  test('every capability response schema still sends its enum options to strict JSON schema providers', async () => {
    const deps = await createTestDeps({ withOthers: true });
    await deps.enrichDocument(documentIds);
    const [{ schema }] = deps.generateStructuredData.mock.calls[0]!;

    const jsonSchema = JSON.stringify(
      toStandardJsonSchema(schema!)['~standard'].jsonSchema.input({ target: 'draft-07' }),
    );

    for (const option of ['Invoice', 'Quote', 'Energy', 'Home', 'Finance']) {
      expect(jsonSchema).toContain(`"${option}"`);
    }
    expect(jsonSchema).toContain('"enum"');
  });

  test('an unexpected error while writing surfaces so the job can fail', async () => {
    const deps = await createTestDeps();
    vi.spyOn(deps.customPropertiesRepository, 'setDocumentCustomPropertyValue').mockRejectedValue(
      new Error('db down'),
    );

    await expect(deps.enrichDocument(documentIds)).rejects.toBeInstanceOf(AggregateError);
  });

  test('without any fillable property and no other capability, the AI is not called', async () => {
    const deps = await createTestDeps({
      customPropertyDefinitions: properties.filter(({ id }) =>
        ['cpd_user', 'cpd_doc', 'cpd_empty'].includes(id),
      ),
    });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).not.toHaveBeenCalled();
  });

  test('tags, title, date and custom properties are produced from a single AI request', async () => {
    const deps = await createTestDeps({
      withOthers: true,
      response: {
        existingTags: ['Finance'],
        title: 'Electricity bill',
        documentDate: '2024-03-15',
        ...fullResponse,
      },
    });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).toHaveBeenCalledTimes(1);
    const [request] = deps.generateStructuredData.mock.calls[0]!;
    for (const section of [
      'DOCUMENT TAGS',
      'DOCUMENT TITLE',
      'DOCUMENT DATE',
      'CUSTOM PROPERTIES',
    ]) {
      expect(request.systemPrompt).toContain(section);
    }
    expect(await deps.db.select().from(documentsTagsTable)).toEqual([
      { documentId: 'doc_1', tagId: 'tag_1' },
    ]);
    expect((await deps.documentsRepository.getDocumentById(documentIds)).document).toMatchObject({
      name: 'Electricity bill.pdf',
      documentDate: new Date('2024-03-15T12:00:00.000Z'),
    });
    expect(await deps.getValues()).toHaveLength(7);
  });

  test('an explicit request for custom properties while the switch is off gets the disabled error', async () => {
    const config = overrideConfig({
      ai: { isEnabled: true },
      documentEnrichment: { customProperties: { isEnabled: false } },
    });
    const schedule = buildScheduleDocumentEnrichment({
      config,
      documentsRepository: {
        getDocumentById: async () => ({ document: { content: 'text', isDeleted: false } as never }),
      },
      resolveOrganizationSettings,
      taskServices: { scheduleJob: vi.fn() } as never,
    });

    await expect(
      schedule({ ...documentIds, capabilities: ['custom-properties'] }),
    ).rejects.toMatchObject({
      code: createDocumentEnrichmentDisabledError().code,
    });
  });
});

describe('custom properties enrichment capability, user properties', () => {
  const userProperties = [
    definition('cpd_user', 'persona', 'user_relation'),
    definition('cpd_doc', 'related', 'document_relation'),
    definition('cpd_text', 'reference', 'text'),
  ];
  const frank = { id: 'usr_frank', name: 'Frank', email: 'frank@email.com' };
  const alice = { id: 'usr_alice', name: 'Alice Martin', email: 'alice@secret-domain.org' };
  const members = [frank, alice];

  const createUserTestDeps = async (args: Parameters<typeof createTestDeps>[0] = {}) =>
    createTestDeps({ customPropertyDefinitions: userProperties, members, ...args });

  const getUserIds = async (deps: Awaited<ReturnType<typeof createTestDeps>>) =>
    (await deps.getValues())
      .filter(({ value }) => value.propertyDefinitionId === 'cpd_user')
      .map(({ value }) => value.userId!)
      .sort((a, b) => a.localeCompare(b));

  test('a member mentioned in the document, even partially, is written as that user', async () => {
    const deps = await createUserTestDeps({
      response: { customProperties: { persona: ['Frank (frank)'], reference: null } },
    });

    await deps.enrichDocument(documentIds);

    expect(await getUserIds(deps)).toEqual(['usr_frank']);
  });

  test('several members mentioned in the document are all written', async () => {
    const deps = await createUserTestDeps({
      response: {
        customProperties: {
          persona: ['Frank (frank)', 'Alice Martin (alice)'],
          reference: null,
        },
      },
    });

    await deps.enrichDocument(documentIds);

    expect(await getUserIds(deps)).toEqual(['usr_alice', 'usr_frank']);
  });

  test('a member without a name is listed by the part of their email before the at sign', async () => {
    const deps = await createUserTestDeps({
      members: [{ id: 'usr_bob', name: null, email: 'bob@email.com' }],
      response: { customProperties: { persona: ['bob'], reference: null } },
    });

    await deps.enrichDocument(documentIds);

    expect(await getUserIds(deps)).toEqual(['usr_bob']);
  });

  test('a label outside the list leaves the property empty and does not affect the other fields', async () => {
    const deps = await createUserTestDeps({
      response: { customProperties: { persona: ['Mallory (mallory)'], reference: 'INV-42' } },
    });

    await deps.enrichDocument(documentIds);

    expect(await getUserIds(deps)).toEqual([]);
    expect((await deps.getValues()).map(({ value }) => value.propertyDefinitionId)).toEqual([
      'cpd_text',
    ]);
  });

  test('null for a user property writes nothing', async () => {
    const deps = await createUserTestDeps({
      response: { customProperties: { persona: null, reference: null } },
    });

    await deps.enrichDocument(documentIds);

    expect(await deps.getValues()).toEqual([]);
  });

  test('a user property that already has a value is never changed nor asked to the model', async () => {
    const deps = await createUserTestDeps();
    await deps.customPropertiesRepository.setDocumentCustomPropertyValue({
      documentId: 'doc_1',
      propertyDefinitionId: 'cpd_user',
      values: [{ userId: 'usr_alice' }],
    });

    await deps.enrichDocument(documentIds);

    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).not.toContain('"key":"persona"');
    expect(await getUserIds(deps)).toEqual(['usr_alice']);
  });

  test('an organization without members has no eligible user property, and document relations are never filled', async () => {
    const deps = await createUserTestDeps({ members: [] });

    await deps.enrichDocument(documentIds);

    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).not.toContain('"key":"persona"');
    expect(request.systemPrompt).not.toContain('"key":"related"');
    expect(request.systemPrompt).not.toContain('organization members');
  });

  test('members sharing the same label are left out of the list', async () => {
    const deps = await createUserTestDeps({
      members: [
        { id: 'usr_a', name: 'Sam', email: 'sam@one.com' },
        { id: 'usr_b', name: 'Sam', email: 'sam@two.com' },
        alice,
      ],
      response: {
        customProperties: { persona: ['Alice Martin (alice)'], reference: null },
      },
    });

    await deps.enrichDocument(documentIds);

    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).not.toContain('Sam (sam)');
    expect(await getUserIds(deps)).toEqual(['usr_alice']);
  });

  test('only labels without any email domain or user id are sent to the model', async () => {
    const deps = await createUserTestDeps();

    await deps.enrichDocument(documentIds);

    const [request] = deps.generateStructuredData.mock.calls[0]!;
    const sent = JSON.stringify([
      request.systemPrompt,
      toStandardJsonSchema(request.schema!)['~standard'].jsonSchema.input({ target: 'draft-07' }),
    ]);
    expect(sent).toContain('Frank (frank)');
    expect(sent).toContain('Alice Martin (alice)');
    for (const secret of ['email.com', 'secret-domain.org', '@', 'usr_frank', 'usr_alice']) {
      expect(request.systemPrompt).not.toContain(secret);
    }
    expect(sent).not.toContain('email.com');
    expect(sent).not.toContain('secret-domain.org');
    expect(sent).not.toContain('usr_');
  });

  test('the user property schema keeps its label enum for strict JSON schema providers', async () => {
    const deps = await createUserTestDeps();
    await deps.enrichDocument(documentIds);
    const [{ schema }] = deps.generateStructuredData.mock.calls[0]!;

    const jsonSchema = toStandardJsonSchema(schema!)['~standard'].jsonSchema.input({
      target: 'draft-07',
    });

    expect(jsonSchema).toMatchObject({
      properties: {
        customProperties: {
          properties: {
            persona: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    enum: expect.arrayContaining(['Frank (frank)', 'Alice Martin (alice)']),
                  },
                },
                { type: 'null' },
              ],
            },
          },
        },
      },
    });
  });

  test('without the switch on, members are not queried', async () => {
    const deps = await createUserTestDeps({ isEnabled: false });
    const membersQuery = vi.spyOn(deps.organizationsRepository, 'getOrganizationMembers');

    await deps.enrichDocument(documentIds);

    expect(membersQuery).not.toHaveBeenCalled();
  });

  test('a member removed while the AI was running skips that property and the others are still written', async () => {
    const deps = await createUserTestDeps({
      response: { customProperties: { persona: ['Frank (frank)'], reference: 'INV-42' } },
    });
    const getOrganizationMembers = deps.organizationsRepository.getOrganizationMembers;
    // Members are listed for the context first, then the member is gone when the value is validated
    vi.spyOn(deps.organizationsRepository, 'getOrganizationMembers')
      .mockImplementationOnce(getOrganizationMembers)
      .mockResolvedValue({ members: [] });

    await deps.enrichDocument(documentIds);

    expect(await getUserIds(deps)).toEqual([]);
    expect((await deps.getValues()).map(({ value }) => value.propertyDefinitionId)).toEqual([
      'cpd_text',
    ]);
  });
});
