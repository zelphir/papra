import * as v from 'valibot';
import { defineDocumentEnrichmentCapabilityFactory } from '../enrichment-capabilities-definition';
import type { Config } from '../../../config/config.types';
import type { EventServices } from '../../../app/events/events.services';
import type { DocumentsRepository } from '../../../documents/documents.repository';
import { updateDocument } from '../../../documents/documents.usecases';
import { parseDocumentDate } from './date.models';

export const buildDateEnrichmentCapability = defineDocumentEnrichmentCapabilityFactory(
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
      name: 'date',

      documentInfoRequirements: [],

      // A date set by the user is never replaced
      isAvailable: ({ document }) =>
        config.ai.isEnabled &&
        config.documentEnrichment.dates.isEnabled &&
        document.documentDate === null,

      buildSystemPromptFragments: () => ({
        fragment: [
          'DOCUMENT DATE',
          '',
          '- Give the date the document was issued, written or signed, in YYYY-MM-DD format.',
          '- Do not return a due date, payment deadline, validity date or other printed date when an issue date exists.',
          '- Return null when there is no clear date. Do not guess.',
        ].join('\n'),
      }),

      getResponseSchema: () => v.object({ documentDate: v.nullable(v.string()) }),

      apply: async ({ response, documentId, organizationId }) => {
        // Re-read right before writing so a date set while the AI was running wins
        const { document } = await documentsRepository.getDocumentById({
          documentId,
          organizationId,
        });

        if (!document || document.isDeleted || document.documentDate !== null) {
          return;
        }

        const documentDate = parseDocumentDate({
          value: response.documentDate,
          now: new Date(),
        });

        if (documentDate === undefined) {
          return;
        }

        await updateDocument({
          documentId,
          organizationId,
          changes: { documentDate },
          documentsRepository,
          eventServices,
        });
      },
    };
  },
);
