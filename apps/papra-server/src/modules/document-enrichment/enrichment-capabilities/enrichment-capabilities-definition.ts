import type { InferOutput } from 'valibot';
import type { OrganizationSettings } from '../../organizations/organization-settings/organization-settings.types';
import type { GenericObjectSchema } from '../../shared/schemas/objects.schemas';
import type { Document } from '../../documents/documents.types';
import type { Tag } from '../../tags/tags.types';
import type { CustomPropertiesRepository } from '../../custom-properties/custom-properties.repository';
import type { DocumentEnrichmentCapability } from '../document-enrichment.schemas';

// Loaded only when a selected capability lists 'custom-properties' in its documentInfoRequirements, empty otherwise
export type EnrichmentCustomProperties = {
  definitions: Awaited<
    ReturnType<CustomPropertiesRepository['getOrganizationPropertyDefinitions']>
  >['propertyDefinitions'];
  values: Awaited<
    ReturnType<CustomPropertiesRepository['getDocumentCustomPropertyValues']>
  >['values'];
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
};

export function defineDocumentEnrichmentCapabilityFactory<
  FactoryArgs = unknown,
  Name extends DocumentEnrichmentCapability = DocumentEnrichmentCapability,
  ResponseSchema extends GenericObjectSchema = GenericObjectSchema,
>(factory: (args: FactoryArgs) => DocumentEnrichmentCapabilityDefinition<Name, ResponseSchema>) {
  return factory;
}
