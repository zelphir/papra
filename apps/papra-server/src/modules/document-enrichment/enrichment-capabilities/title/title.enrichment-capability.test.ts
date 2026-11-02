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
import { documentsTagsTable } from '../../../tags/tags.table';
import { applyTagsToDocuments, createTag } from '../../../tags/tags.usecases';
import { buildEnrichDocument } from '../../document-enrichment.usecases';
import { buildTagsEnrichmentCapability } from '../tags/tags.enrichment-capability';
import { buildTitleEnrichmentCapability } from './title.enrichment-capability';

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
  isTitlesEnabled = true,
  response = { title: 'Electricity bill March 2024' } as Record<string, unknown>,
  withTags = false,
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
        content: 'Electricity bill for March 2024',
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
    documentEnrichment: { titles: { isEnabled: isTitlesEnabled } },
  });
  const documentsRepository = createDocumentsRepository({ db });
  const tagsRepository = createTagsRepository({ db });
  const eventServices = createTestEventServices();
  const { logger } = createTestLogger();
  const generateStructuredData = vi
    .fn<AiServices['generateStructuredData']>()
    .mockResolvedValue(response);

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
      capabilityDefinitions: withTags ? [tagsCapability, titleCapability] : [titleCapability],
    }),
  };
}

describe('title enrichment capability', () => {
  test('a document with a meaningless name is renamed from its content, keeping its extension and original name', async () => {
    const deps = await createTestDeps();

    await deps.enrichDocument(documentIds);

    expect(await deps.getDocument()).toMatchObject({
      name: 'Electricity bill March 2024.pdf',
      originalName: 'SCAN_0001.pdf',
    });
    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).toContain('DOCUMENT TITLE');
    expect(v.parse(request.schema!, { title: null })).toEqual({ title: null });
  });

  test('renaming emits a document.updated event without a user, so webhooks and search indexing run', async () => {
    const deps = await createTestDeps();

    await deps.enrichDocument(documentIds);

    expect(deps.eventServices.getEmittedEvents()).toEqual([
      {
        eventName: 'document.updated',
        payload: {
          userId: undefined,
          changes: { name: 'Electricity bill March 2024.pdf' },
          document: expect.objectContaining({ id: 'doc_1' }),
        },
      },
    ]);
  });

  test('when titles are disabled, nothing is added to the prompt or schema and the AI is not called', async () => {
    const deps = await createTestDeps({ isTitlesEnabled: false, withTags: true });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).toHaveBeenCalledTimes(1);
    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).not.toContain('DOCUMENT TITLE');
    expect(
      Object.keys((request.schema as v.ObjectSchema<v.ObjectEntries, undefined>).entries),
    ).toEqual(['existingTags']);
    expect((await deps.getDocument()).name).toEqual('SCAN_0001.pdf');
  });

  test('a document renamed by the user is never touched, and the AI is not called when nothing else is available', async () => {
    const deps = await createTestDeps({ name: 'My lease' });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).not.toHaveBeenCalled();
    expect((await deps.getDocument()).name).toEqual('My lease');
  });

  test('when the model abstains with null, the name is unchanged', async () => {
    const deps = await createTestDeps({ response: { title: null } });

    await deps.enrichDocument(documentIds);

    expect((await deps.getDocument()).name).toEqual('SCAN_0001.pdf');
    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
  });

  test('a rename made by the user while the AI was running is preserved', async () => {
    const deps = await createTestDeps();
    deps.generateStructuredData.mockImplementation(async () => {
      await deps.documentsRepository.updateDocument({ ...documentIds, name: 'My lease.pdf' });
      return { title: 'Electricity bill March 2024' };
    });

    await deps.enrichDocument(documentIds);

    expect(await deps.getDocument()).toMatchObject({
      name: 'My lease.pdf',
      originalName: 'SCAN_0001.pdf',
    });
    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
  });

  test('a document trashed while the AI was running is not renamed', async () => {
    const deps = await createTestDeps();
    deps.generateStructuredData.mockImplementation(async () => {
      await deps.documentsRepository.softDeleteDocument({ ...documentIds, userId: 'user_1' });
      return { title: 'Electricity bill March 2024' };
    });

    await deps.enrichDocument(documentIds);

    expect(deps.eventServices.getEmittedEvents()).toEqual([]);
  });

  test('tags and title are produced from a single AI request', async () => {
    const deps = await createTestDeps({
      withTags: true,
      response: { existingTags: ['Finance'], title: 'Electricity bill March 2024' },
    });

    await deps.enrichDocument(documentIds);

    expect(deps.generateStructuredData).toHaveBeenCalledTimes(1);
    const [request] = deps.generateStructuredData.mock.calls[0]!;
    expect(request.systemPrompt).toContain('DOCUMENT TAGS');
    expect(request.systemPrompt).toContain('DOCUMENT TITLE');
    expect((await deps.getDocument()).name).toEqual('Electricity bill March 2024.pdf');
    expect(await deps.db.select().from(documentsTagsTable)).toEqual([
      { documentId: 'doc_1', tagId: 'tag_1' },
    ]);
  });

  test('a title failure does not prevent tags from being applied', async () => {
    const deps = await createTestDeps({
      withTags: true,
      response: { existingTags: ['Finance'], title: 'Electricity bill March 2024' },
    });
    vi.spyOn(deps.documentsRepository, 'updateDocument').mockRejectedValue(new Error('db down'));

    await expect(deps.enrichDocument(documentIds)).rejects.toBeInstanceOf(AggregateError);

    expect(await deps.db.select().from(documentsTagsTable)).toEqual([
      { documentId: 'doc_1', tagId: 'tag_1' },
    ]);
    expect((await deps.getDocument()).name).toEqual('SCAN_0001.pdf');
  });
});
