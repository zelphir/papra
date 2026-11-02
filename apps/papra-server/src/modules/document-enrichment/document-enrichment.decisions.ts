import type { Logger } from '@crowlog/logger';
import type { Document } from '../documents/documents.types';
import type { AiServices } from '../ai/ai.services';
import type { OrganizationSettings } from '../organizations/organization-settings/organization-settings.types';
import type { Tag } from '../tags/tags.types';
import {
  MAX_DECISION_CONTENT_LENGTH,
  truncateEnrichmentContent,
} from './document-enrichment.models';
import type {
  DecisionAnswer,
  DecisionOutcome,
  DocumentEnrichmentCapabilityDefinition,
  EnrichmentCustomProperties,
} from './enrichment-capabilities/enrichment-capabilities-definition';

// Only a clear answer is acted on, anything in between is left to the language model
export const DECISION_YES_THRESHOLD = 0.9;
export const DECISION_NO_THRESHOLD = 0.1;

// A boolean answer probability is P(yes), the probability of the returned value for a choice is P(picked option)
export const isClearYes = (probability: number) => probability >= DECISION_YES_THRESHOLD;
export const isClearNo = (probability: number) => probability <= DECISION_NO_THRESHOLD;

// The characters allowed in question keys are not documented, so they stick to letters, digits and underscores
const buildQuestionKey = ({ capabilityName, key }: { capabilityName: string; key: string }) =>
  `${capabilityName.replaceAll('-', '_')}__${key}`;

// oxlint-disable-next-line typescript/no-explicit-any
type AnyCapability = DocumentEnrichmentCapabilityDefinition<any, any>;

/**
 * Asks the decision model the closed questions of the available capabilities in one call.
 * The decision model is never required: when it is not configured, or anything goes wrong, no capability is settled and the language model handles everything.
 * Question keys are prefixed by the capability name, so they are unique across capabilities.
 */
export async function decideCapabilities({
  capabilities,
  document,
  organizationSettings,
  tags,
  customProperties,
  aiServices,
  logger,
}: {
  capabilities: AnyCapability[];
  document: Document;
  organizationSettings: OrganizationSettings;
  tags: Tag[];
  customProperties: EnrichmentCustomProperties;
  aiServices: Pick<AiServices, 'decide' | 'isDecisionModelConfigured'>;
  logger: Logger;
}) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const outcomes = new Map<string, DecisionOutcome<any>>();

  if (!aiServices.isDecisionModelConfigured) {
    return outcomes;
  }

  const context = { organizationSettings, tags, customProperties };
  const questionsByCapability = capabilities.map((capability) => ({
    capability,
    questions: capability.decisions?.getQuestions(context) ?? {},
  }));

  const questions = Object.fromEntries(
    questionsByCapability.flatMap(({ capability, questions }) =>
      Object.entries(questions).map(([key, question]) => [
        buildQuestionKey({ capabilityName: capability.name, key }),
        question,
      ]),
    ),
  );

  if (Object.keys(questions).length === 0) {
    return outcomes;
  }

  try {
    const answers = (await aiServices.decide({
      state: {
        name: document.originalName,
        content: truncateEnrichmentContent({
          content: document.content,
          maxLength: MAX_DECISION_CONTENT_LENGTH,
        }),
      },
      questions,
      source: 'decision',
      organizationId: document.organizationId,
    })) as Record<string, DecisionAnswer>;

    for (const { capability, questions } of questionsByCapability) {
      if (Object.keys(questions).length === 0) {
        continue;
      }

      outcomes.set(
        capability.name,
        capability.decisions!.resolve({
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              answers[buildQuestionKey({ capabilityName: capability.name, key })]!,
            ]),
          ),
          ...context,
        }),
      );
    }
  } catch (error) {
    // Jev is optional: whatever fails, the language model handles everything
    // The error message can contain the provider response, so only its name is logged
    logger.warn(
      {
        documentId: document.id,
        organizationId: document.organizationId,
        errorName: error instanceof Error ? error.name : undefined,
      },
      'The decision model failed, falling back to the language model.',
    );

    outcomes.clear();
  }

  return outcomes;
}
