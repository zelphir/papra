import type { BooleanAnswer, ChoiceAnswer, WireQuestion } from '@tanstack/ai';
import type { InferOutput } from 'valibot';
import type { OrganizationSettings } from '../../organizations/organization-settings/organization-settings.types';
import type { GenericObjectSchema } from '../../shared/schemas/objects.schemas';
import type { Document } from '../../documents/documents.types';
import type { Tag } from '../../tags/tags.types';
import type { CustomPropertiesRepository } from '../../custom-properties/custom-properties.repository';
import type { OrganizationsRepository } from '../../organizations/organizations.repository';
import type { DocumentEnrichmentCapability } from '../document-enrichment.schemas';

// Loaded only when a selected capability lists 'custom-properties' in its documentInfoRequirements, empty otherwise
export type EnrichmentCustomProperties = {
  definitions: Awaited<
    ReturnType<CustomPropertiesRepository['getOrganizationPropertyDefinitions']>
  >['propertyDefinitions'];
  values: Awaited<
    ReturnType<CustomPropertiesRepository['getDocumentCustomPropertyValues']>
  >['values'];
  // Organization members, the users a user property can point to
  members: Awaited<ReturnType<OrganizationsRepository['getOrganizationMembers']>>['members'];
};

export type DecisionAnswer = BooleanAnswer | ChoiceAnswer;

// What the decision model settled. The language model request only keeps what is left.
export type DecisionOutcome<ResponseSchema extends GenericObjectSchema> = {
  // Merged with the language model response before apply
  response: Partial<InferOutput<ResponseSchema>>;
  // True when nothing is left for the language model
  isSettled: boolean;
  // What is left for the language model, when it is only part of the properties
  customProperties?: EnrichmentCustomProperties;
};

export type DocumentEnrichmentCapabilityDefinition<
  Name extends string = string,
  ResponseSchema extends GenericObjectSchema = GenericObjectSchema,
> = {
  name: Name;

  isAvailable: (args: {
    organizationSettings: OrganizationSettings;
    tags: Tag[];
    document: Document;
    customProperties: EnrichmentCustomProperties;
  }) => boolean;

  buildSystemPromptFragments: (args: {
    organizationSettings: OrganizationSettings;
    tags: Tag[];
    customProperties: EnrichmentCustomProperties;
  }) => {
    fragment: string;
  };

  getResponseSchema: (args: {
    organizationSettings: OrganizationSettings;
    tags: Tag[];
    customProperties: EnrichmentCustomProperties;
  }) => ResponseSchema;

  apply: (args: {
    documentId: string;
    organizationId: string;
    response: InferOutput<ResponseSchema>;
    organizationSettings: OrganizationSettings;
    tags: Tag[];
    customProperties: EnrichmentCustomProperties;
  }) => Promise<void>;

  documentInfoRequirements: ('tags' | 'custom-properties')[];

  // Closed questions the optional decision model answers before the language model.
  // Keys are local to the capability and must not come from user-written strings.
  decisions?: {
    getQuestions: (args: {
      organizationSettings: OrganizationSettings;
      tags: Tag[];
      customProperties: EnrichmentCustomProperties;
    }) => Record<string, WireQuestion>;

    // Receives the answers to its own questions, anything not clear is left to the language model
    resolve: (args: {
      answers: Record<string, DecisionAnswer>;
      organizationSettings: OrganizationSettings;
      tags: Tag[];
      customProperties: EnrichmentCustomProperties;
    }) => DecisionOutcome<ResponseSchema>;
  };
};

export function defineDocumentEnrichmentCapabilityFactory<
  FactoryArgs = unknown,
  Name extends DocumentEnrichmentCapability = DocumentEnrichmentCapability,
  ResponseSchema extends GenericObjectSchema = GenericObjectSchema,
>(factory: (args: FactoryArgs) => DocumentEnrichmentCapabilityDefinition<Name, ResponseSchema>) {
  return factory;
}
