import { boolean } from '@tanstack/ai';
import * as v from 'valibot';
import { isClearNo, isClearYes } from '../../document-enrichment.decisions';
import { defineDocumentEnrichmentCapabilityFactory } from '../enrichment-capabilities-definition';
import type { buildApplyAutoTaggingActions } from '../../../auto-tagging/auto-tagging.usecases';
import type { Config } from '../../../config/config.types';
import { getTagsActions } from '../../../auto-tagging/auto-tagging.models';

// Above this, the questions alone get large against the request context limit, so the language model does it all
const MAX_DECISION_TAGS = 100;

// Asked only when the language model cannot create tags, otherwise it is needed anyway and would re-judge the same existing tags
const shouldDecideTags = ({
  canCreateNewTags,
  tagsCount,
}: {
  canCreateNewTags: boolean;
  tagsCount: number;
}) => !canCreateNewTags && tagsCount > 0 && tagsCount <= MAX_DECISION_TAGS;

export const buildTagsEnrichmentCapability = defineDocumentEnrichmentCapabilityFactory(
  ({
    config,
    applyAutoTaggingActions,
  }: {
    config: Config;
    applyAutoTaggingActions: ReturnType<typeof buildApplyAutoTaggingActions>;
  }) => {
    return {
      name: 'auto-tagging',

      documentInfoRequirements: ['tags'],

      isAvailable: ({ organizationSettings, tags }) =>
        config.ai.isEnabled &&
        config.autoTagging.isEnabled &&
        organizationSettings.ai.autoTagging.isEnabled &&
        (organizationSettings.ai.autoTagging.canCreateNewTags || tags.length > 0),

      buildSystemPromptFragments: ({ organizationSettings }) => {
        const { canCreateNewTags, maxTags } = organizationSettings.ai.autoTagging;
        const { instructions } = config.autoTagging;

        return {
          fragment: [
            'DOCUMENT TAGS',
            '',
            '- Suggest tags that are relevant to the document content.',
            `- Select at most ${maxTags} tags.`,

            ...(canCreateNewTags
              ? [
                  '- You may suggest new tags that do not exist yet.',
                  '- If you suggest new tags, provide an optional description for each new tag.',
                  '- Do not suggest new tags that are too similar to existing tags.',
                  '- Prefer existing tags whenever one fits.',
                  '- New tags must be short, general categories that would apply to many documents, not unique details such as names, numbers or dates.',
                  '- New tags must follow the language and naming style of the existing tags, when there are any.',
                ]
              : [
                  '- You may only suggest existing tags.',
                  '- If no relevant tags can be found, return an empty list.',
                ]),

            ...(instructions?.trim()
              ? [
                  '',
                  'ADDITIONAL TAGGING INSTRUCTIONS (from the administrator):',
                  instructions.trim(),
                ]
              : []),
          ].join('\n'),
        };
      },

      getResponseSchema: ({ organizationSettings, tags }) => {
        const hasExistingTags = tags.length > 0;
        const { canCreateNewTags } = organizationSettings.ai.autoTagging;

        if (canCreateNewTags && hasExistingTags) {
          return v.object({
            existingTags: v.fallback(v.array(v.picklist(tags.map((tag) => tag.name))), []),
            newTags: v.fallback(
              v.array(v.object({ name: v.string(), description: v.optional(v.string()) })),
              [],
            ),
          });
        }

        if (canCreateNewTags && !hasExistingTags) {
          return v.object({
            newTags: v.fallback(
              v.array(v.object({ name: v.string(), description: v.optional(v.string()) })),
              [],
            ),
          });
        }

        return v.object({
          existingTags: v.fallback(v.array(v.picklist(tags.map((tag) => tag.name))), []),
        });
      },

      decisions: {
        // Keys are tag positions, never tag names
        getQuestions: ({ organizationSettings, tags }) =>
          shouldDecideTags({
            canCreateNewTags: organizationSettings.ai.autoTagging.canCreateNewTags,
            tagsCount: tags.length,
          })
            ? Object.fromEntries(
                tags.map((tag, index) => [
                  `tag_${index}`,
                  boolean({
                    instructions: `Is the tag "${tag.name}"${tag.description ? ` (${tag.description})` : ''} relevant to this document?`,
                  }),
                ]),
              )
            : {},

        // Settled only when every tag has a clear answer, otherwise the language model tags the document in full
        resolve: ({ answers, organizationSettings, tags }) => {
          const probabilities = tags.map((_, index) => answers[`tag_${index}`]!.probability);

          if (
            probabilities.some((probability) => !isClearYes(probability) && !isClearNo(probability))
          ) {
            return { response: {}, isSettled: false };
          }

          return {
            response: {
              existingTags: tags
                .map((tag, index) => ({ name: tag.name, probability: probabilities[index]! }))
                .filter(({ probability }) => isClearYes(probability))
                .sort((a, b) => b.probability - a.probability)
                .slice(0, organizationSettings.ai.autoTagging.maxTags)
                .map(({ name }) => name),
            },
            isSettled: true,
          };
        },
      },

      apply: async ({ response, documentId, organizationId, tags, organizationSettings }) => {
        const actions = getTagsActions({
          autoTaggingResponse: response,
          existingTags: tags,
          maxTags: organizationSettings.ai.autoTagging.maxTags,
        });

        await applyAutoTaggingActions({
          documentId,
          organizationId,
          ...actions,
        });
      },
    };
  },
);
