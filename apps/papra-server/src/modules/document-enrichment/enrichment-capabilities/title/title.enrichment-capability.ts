import { boolean } from '@tanstack/ai';
import * as v from 'valibot';
import { isClearYes } from '../../document-enrichment.decisions';
import { nullableOrNull } from '../../document-enrichment.schemas';
import { defineDocumentEnrichmentCapabilityFactory } from '../enrichment-capabilities-definition';
import type { Config } from '../../../config/config.types';
import type { EventServices } from '../../../app/events/events.services';
import type { DocumentsRepository } from '../../../documents/documents.repository';
import { updateDocument } from '../../../documents/documents.usecases';
import { buildDocumentNameFromTitle } from './title.models';

export const buildTitleEnrichmentCapability = defineDocumentEnrichmentCapabilityFactory(
  ({
    config,
    documentsRepository,
    eventServices,
  }: {
    config: Config;
    documentsRepository: DocumentsRepository;
    eventServices: EventServices;
  }) => {
    return {
      name: 'title',

      documentInfoRequirements: [],

      // A document renamed by the user is never touched
      isAvailable: ({ document }) =>
        config.ai.isEnabled &&
        config.documentEnrichment.titles.isEnabled &&
        document.name === document.originalName,

      buildSystemPromptFragments: () => ({
        fragment: [
          'DOCUMENT TITLE',
          '',
          '- Suggest a concise, human-readable title describing what the document is.',
          '- Write the title in the same language as the document content.',
          '- Do not include a file extension.',
          '- Return null when the original filename is already clear and descriptive, or when the content gives too little to go on.',
        ].join('\n'),
      }),

      getResponseSchema: () => v.object({ title: nullableOrNull(v.string()) }),

      decisions: {
        getQuestions: () => ({
          clear: boolean({
            instructions: 'Is this filename already clear and descriptive of the document?',
          }),
        }),

        // A clear filename needs no new title
        resolve: ({ answers }) =>
          isClearYes(answers.clear!.probability)
            ? { response: { title: null }, isSettled: true }
            : { response: {}, isSettled: false },
      },

      apply: async ({ response, documentId, organizationId }) => {
        // Re-read right before writing so a rename made while the AI was running wins
        const { document } = await documentsRepository.getDocumentById({
          documentId,
          organizationId,
        });

        if (!document || document.isDeleted || document.name !== document.originalName) {
          return;
        }

        const name = buildDocumentNameFromTitle({
          title: response.title,
          originalName: document.originalName,
        });

        if (name === undefined || name === document.name) {
          return;
        }

        await updateDocument({
          documentId,
          organizationId,
          changes: { name },
          documentsRepository,
          eventServices,
        });
      },
    };
  },
);
