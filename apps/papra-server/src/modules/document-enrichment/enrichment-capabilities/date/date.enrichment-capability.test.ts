import { describe, expect, test, vi } from 'vitest';
import * as v from 'valibot';
import type { AiServices } from '../../../ai/ai.services';
import { createInMemoryDatabase } from '../../../app/database/database.test-utils';
import { createTestEventServices } from '../../../app/events/events.test-utils';
import { buildApplyAutoTaggingActions } from '../../../auto-tagging/auto-tagging.usecases';
import { overrideConfig } from '../../../config/config.test-utils';
import { createCustomPropertiesRepository } from '../../../custom-properties/custom-properties.repository';
import { createOrganizationsRepository } from '../../../organizations/organizations.repository';
import { createDocumentsRepository } from '../../../documents/documents.repository';
import type { ResolveOrganizationSettingsUsecase } from '../../../organizations/organization-settings/organization-settings.usecases';
import { createTestLogger } from '../../../shared/logger/logger.test-utils';
import { createTagsRepository } from '../../../tags/tags.repository';
import { applyTagsToDocuments, createTag } from '../../../tags/tags.usecases';
import { buildEnrichDocument } from '../../document-enrichment.usecases';
import { buildTagsEnrichmentCapability } from '../tags/tags.enrichment-capability';
import { buildTitleEnrichmentCapability } from '../title/title.enrichment-capability';
import { buildDateEnrichmentCapability } from './date.enrichment-capability';

const documentIds = { documentId: 'doc_1', organizationId: 'org_1' };

const resolveOrganizationSettings: ResolveOrganizationSettingsUsecase = async () => ({
  organizationSettings: {
    ai: {
      autoTagging: { isEnabled: true, canCreateNewTags: false, maxTags: 5, modelId: 'gpt-4' },
    },
  },
});

async function createTestDeps({
  name = 'SCAN_0001.pdf',
  originalName = 'SCAN_0001.pdf',
  documentDate = null as Date | null,
  isDatesEnabled = true,
  isTitlesEnabled = false,
  response = { documentDate: '2024-03-15' } as Record<string, unknown>,
  withTags = false,
  withTitle = false,
} = {}) {
  const { db } = await createInMemoryDatabase({
    users: [{ id: 'user_1', email: 'user@example.com' }],
    organizations: [{ id: 'org_1', name: 'Org 1' }],
    documents: [
      {
        id: 'doc_1',
        organizationId: 'org_1',
        name,
        originalName,
        originalStorageKey: 'doc_1',
        originalSha256Hash: 'doc_1',
        mimeType: 'application/pdf',
        content: 'Electricity bill issued on 15 March 2024',
        documentDate,
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
  });
  const config = overrideConfig({
    ai: { isEnabled: true },
    autoTagging: { isEnabled: true },
    documentEnrichment: {
      titles: { isEnabled: isTitlesEnabled },
      dates: { isEnabled: isDatesEnabled },
    },
  });
  const documentsRepository = createDocumentsRepository({ db });
  const tagsRepository = createTagsRepository({ db });
  const eventServices = createTestEventServices();
  const { logger } = createTestLogger();
  const generateStructuredData = vi
    .fn<AiServices['generateStructuredData']>()
    .mockResolvedValue(response);

  const dateCapability = buildDateEnrichmentCapability({
    config,
    documentsRepository,
    eventServices,
  });
  const titleCapability = buildTitleEnrichmentCapability({
    config,
    documentsRepository,
    eventServices,
  });
  const tagsCapability = buildTagsEnrichmentCapability({
    config,
    applyAutoTaggingActions: buildApplyAutoTaggingActions({
      createTag: async (args) => createTag({ ...args, config, tagsRepository }),
      applyTagsToDocuments: async (args) =>
        applyTagsToDocuments({ ...args, tagsRepository, eventServices, logger }),
    }),
  });

  const capabilityDefinitions = [
    ...(withTags ? [tagsCapability] : []),
    ...(withTitle ? [titleCapability] : []),
    dateCapability,
  ];

  return {
    db,
    generateStructuredData,
    eventServices,
    documentsRepository,
    getDocument: async () => (await documentsRepository.getDocumentById(documentIds)).document!,
    enrichDocument: buildEnrichDocument({
      config,
      documentsRepository,
      tagsRepository,
      customPropertiesRepository: createCustomPropertiesRepository({ db }),
      organizationsRepository: createOrganizationsRepository({ db }),
      logger,
      resolveOrganizationSettings,
      aiServices: { generateStructuredData } as unknown as AiServices,
      capabilityDefinitions,
    }),
  };
}

describe('date enrichment capability', () => {
  test('a document without a date gets the date the AI found, stored as that calendar day', async () => {
    const deps = await createTestDeps();

    await deps.enrichDocument(documentIds);

    expect(await deps.getDocument()).toMatchObject({
      documentDate: new Date('2024-03-15T12:00:00.000Z'),
      name: 'SCAN_0001.pdf',
    });
    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).toContain('DOCUMENT DATE');
    expect(v.parse(request.schema!, { documentDate: null })).toEqual({ documentDate: null });
  });

  test('setting the date emits a document.updated event without a user, so webhooks and search indexing run', async () => {
    const deps = await createTestDeps();

    await deps.enrichDocument(documentIds);

    expect(deps.eventServices.getEmittedEvents()).toEqual([
      {
        eventName: 'document.updated',
        payload: {
          userId: undefined,
          changes: { documentDate: new Date('2024-03-15T12:00:00.000Z') },
          document: expect.objectContaining({ id: 'doc_1' }),
        },
      },
    ]);
  });

  test('when dates are disabled, nothing is added to the prompt or schema and the AI is not called for the date alone', async () => {
    const deps = await createTestDeps({ isDatesEnabled: false, withTags: true });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).toHaveBeenCalledTimes(1);
    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).not.toContain('DOCUMENT DATE');
    expect(
      Object.keys((request.schema as v.ObjectSchema<v.ObjectEntries, undefined>).entries),
    ).toEqual(['existingTags']);
    expect((await deps.getDocument()).documentDate).toEqual(null);
  });

  test('when dates are disabled and no other capability is requested, the AI is not called', async () => {
    const deps = await createTestDeps({ isDatesEnabled: false });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).not.toHaveBeenCalled();
    expect((await deps.getDocument()).documentDate).toEqual(null);
  });

  test('a date set by the user is never replaced, and the AI is not called when nothing else is available', async () => {
    const userDate = new Date('2020-01-02T12:00:00.000Z');
    const deps = await createTestDeps({ documentDate: userDate });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).not.toHaveBeenCalled();
    expect((await deps.getDocument()).documentDate).toEqual(userDate);
    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
  });

  test('when the model abstains with null, the date stays empty', async () => {
    const deps = await createTestDeps({ response: { documentDate: null } });

    await deps.enrichDocument(documentIds);

    expect((await deps.getDocument()).documentDate).toEqual(null);
    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
  });

  test('an impossible date from the model is ignored', async () => {
    const deps = await createTestDeps({ response: { documentDate: '2026-02-30' } });

    await deps.enrichDocument(documentIds);

    expect((await deps.getDocument()).documentDate).toEqual(null);
    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
  });

  test('a date set by the user while the AI was running is preserved', async () => {
    const deps = await createTestDeps();
    const userDate = new Date('2019-05-06T12:00:00.000Z');
    deps.generateStructuredData.mockImplementation(async () => {
      await deps.documentsRepository.updateDocument({ ...documentIds, documentDate: userDate });
      return { documentDate: '2024-03-15' };
    });

    await deps.enrichDocument(documentIds);

    expect((await deps.getDocument()).documentDate).toEqual(userDate);
    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
  });

  test('a document trashed while the AI was running is not changed', async () => {
    const deps = await createTestDeps();
    deps.generateStructuredData.mockImplementation(async () => {
      await deps.documentsRepository.softDeleteDocument({ ...documentIds, userId: 'user_1' });
      return { documentDate: '2024-03-15' };
    });

    await deps.enrichDocument(documentIds);

    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
    expect((await deps.getDocument()).documentDate).toEqual(null);
  });

  test('a title and a date requested together both land, and the final document holds both', async () => {
    const deps = await createTestDeps({
      withTitle: true,
      isTitlesEnabled: true,
      response: { title: 'Electricity bill March 2024', documentDate: '2024-03-15' },
    });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).toHaveBeenCalledTimes(1);
    expect(await deps.getDocument()).toMatchObject({
      name: 'Electricity bill March 2024.pdf',
      documentDate: new Date('2024-03-15T12:00:00.000Z'),
    });
  });
});
