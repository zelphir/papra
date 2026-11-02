import type { Logger } from '@crowlog/logger';
import { safely } from '@corentinth/chisels';
import { defineDocumentEnrichmentCapabilityFactory } from '../enrichment-capabilities-definition';
import type { Config } from '../../../config/config.types';
import type { CustomPropertiesRepository } from '../../../custom-properties/custom-properties.repository';
import type { CustomPropertiesOptionsRepository } from '../../../custom-properties/options/custom-properties-options.repository';
import type { DocumentsRepository } from '../../../documents/documents.repository';
import type { OrganizationsRepository } from '../../../organizations/organizations.repository';
import { isErrorWithCode } from '../../../shared/errors/errors';
import { createLogger } from '../../../shared/logger/logger';
import { setDocumentCustomPropertyValue } from '../../../custom-properties/custom-properties.usecases';
import {
  createCustomPropertyDefinitionNotFoundError,
  createCustomPropertyValueInvalidError,
} from '../../../custom-properties/custom-properties.errors';
import { createCustomPropertySelectOptionNotFoundError } from '../../../custom-properties/options/custom-properties-options.errors';
import {
  buildCustomPropertiesPromptFragment,
  getCustomPropertiesResponseSchema,
  getEligibleProperties,
  toCustomPropertyValue,
} from './custom-properties.models';

const INVALID_VALUE_ERROR_CODES = [
  createCustomPropertyValueInvalidError().code,
  createCustomPropertySelectOptionNotFoundError().code,
  // The definition was deleted while the AI was running
  createCustomPropertyDefinitionNotFoundError().code,
];

export const buildCustomPropertiesEnrichmentCapability = defineDocumentEnrichmentCapabilityFactory(
  ({
    config,
    documentsRepository,
    customPropertiesRepository,
    customPropertiesOptionsRepository,
    organizationsRepository,
    logger = createLogger({ namespace: 'documentEnrichment' }),
  }: {
    config: Config;
    documentsRepository: DocumentsRepository;
    customPropertiesRepository: CustomPropertiesRepository;
    customPropertiesOptionsRepository: CustomPropertiesOptionsRepository;
    organizationsRepository: OrganizationsRepository;
    logger?: Logger;
  }) => {
    const isEnabled = config.ai.isEnabled && config.documentEnrichment.customProperties.isEnabled;

    return {
      name: 'custom-properties',

      // The definitions and values are only loaded when the capability is enabled
      documentInfoRequirements: isEnabled ? ['custom-properties'] : [],

      isAvailable: ({ customProperties }) =>
        isEnabled && getEligibleProperties(customProperties).length > 0,

      buildSystemPromptFragments: ({ customProperties }) => ({
        fragment: buildCustomPropertiesPromptFragment({
          properties: getEligibleProperties(customProperties),
        }),
      }),

      getResponseSchema: ({ customProperties }) =>
        getCustomPropertiesResponseSchema({ properties: getEligibleProperties(customProperties) }),

      apply: async ({ response, documentId, organizationId, customProperties }) => {
        // Re-read right before writing so a document trashed or a value set while the AI was running wins
        const [{ document }, { values }] = await Promise.all([
          documentsRepository.getDocumentById({ documentId, organizationId }),
          customPropertiesRepository.getDocumentCustomPropertyValues({ documentId }),
        ]);

        if (!document || document.isDeleted) {
          return;
        }

        const properties = getEligibleProperties({
          definitions: customProperties.definitions,
          values,
        });

        for (const property of properties) {
          const value = toCustomPropertyValue({
            property,
            value: response.customProperties[property.key],
          });

          if (value === undefined) {
            continue;
          }

          const [, error] = await safely(
            setDocumentCustomPropertyValue({
              documentId,
              organizationId,
              propertyDefinitionId: property.id,
              value,
              customPropertiesRepository,
              customPropertiesOptionsRepository,
              organizationsRepository,
              documentsRepository,
            }),
          );

          // One invalid suggestion must not block the other properties, anything else is unexpected
          if (error === null || error === undefined) {
            continue;
          }

          if (!INVALID_VALUE_ERROR_CODES.some((code) => isErrorWithCode({ error, code }))) {
            throw error;
          }

          logger.warn(
            { documentId, organizationId, propertyDefinitionId: property.id, error },
            'Ignoring an invalid AI suggested custom property value.',
          );
        }
      },
    };
  },
);
