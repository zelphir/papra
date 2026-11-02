import { boolean, choice } from '@tanstack/ai';
import * as v from 'valibot';
import { CUSTOM_PROPERTY_TYPES } from '../../../custom-properties/custom-properties.constants';
import { nullableOrNull } from '../../document-enrichment.schemas';
import { isClearNo, isClearYes } from '../../document-enrichment.decisions';
import { parseCalendarDate } from '../date/date.models';
import type {
  DecisionAnswer,
  DecisionOutcome,
  EnrichmentCustomProperties,
} from '../enrichment-capabilities-definition';

type PropertyDefinition = EnrichmentCustomProperties['definitions'][number];

// Relation types point to users and documents the AI cannot know about
const FILLABLE_TYPES: string[] = [
  CUSTOM_PROPERTY_TYPES.TEXT,
  CUSTOM_PROPERTY_TYPES.NUMBER,
  CUSTOM_PROPERTY_TYPES.DATE,
  CUSTOM_PROPERTY_TYPES.BOOLEAN,
  CUSTOM_PROPERTY_TYPES.SELECT,
  CUSTOM_PROPERTY_TYPES.MULTI_SELECT,
];

const isSelectType = (type: string) =>
  type === CUSTOM_PROPERTY_TYPES.SELECT || type === CUSTOM_PROPERTY_TYPES.MULTI_SELECT;

/**
 * The properties the AI may fill: supported types that have no value on the document yet.
 * A property with any existing value is never changed.
 */
export function getEligibleProperties({
  definitions,
  values,
}: EnrichmentCustomProperties): PropertyDefinition[] {
  const valuedPropertyIds = new Set(values.map(({ value }) => value.propertyDefinitionId));

  return definitions.filter(
    (definition) =>
      FILLABLE_TYPES.includes(definition.type) &&
      !valuedPropertyIds.has(definition.id) &&
      (!isSelectType(definition.type) || definition.options.length > 0),
  );
}

function getPropertyValueSchema(property: PropertyDefinition) {
  const optionNames = property.options.map((option) => option.name);

  switch (property.type) {
    case CUSTOM_PROPERTY_TYPES.NUMBER:
      return v.number();
    case CUSTOM_PROPERTY_TYPES.BOOLEAN:
      return v.boolean();
    case CUSTOM_PROPERTY_TYPES.SELECT:
      return v.picklist(optionNames);
    case CUSTOM_PROPERTY_TYPES.MULTI_SELECT:
      return v.array(v.picklist(optionNames));
    // text and date (YYYY-MM-DD) are plain strings
    default:
      return v.string();
  }
}

// Every entry is required but nullable so the model can abstain, as strict JSON schema providers need
export function getCustomPropertiesResponseSchema({
  properties,
}: {
  properties: PropertyDefinition[];
}) {
  const customPropertiesSchema = v.object(
    Object.fromEntries(
      properties.map((property) => [
        property.key,
        nullableOrNull(getPropertyValueSchema(property)),
      ]),
    ),
  );

  return v.object({
    // Every property falls back to null, so a missing or mangled object leaves the properties empty
    customProperties: v.fallback(customPropertiesSchema, v.getFallbacks(customPropertiesSchema)),
  });
}

export function buildCustomPropertiesPromptFragment({
  properties,
}: {
  properties: PropertyDefinition[];
}) {
  return [
    'CUSTOM PROPERTIES',
    '',
    '- Fill the properties below, using their key in the customProperties object.',
    '- Fill a property only when the document clearly states its value, otherwise return null. Never guess.',
    '- Numbers are plain numbers without units, currency symbols or formatting.',
    '- Dates are in YYYY-MM-DD format.',
    '- Text values are short, copied or closely based on the document, in the document language.',
    '- Select values must be one of the listed options, multi select values a list of them.',
    '',
    ...properties.map((property) =>
      JSON.stringify({
        key: property.key,
        name: property.name,
        description: property.description,
        type: property.type,
        ...(isSelectType(property.type)
          ? { options: property.options.map((option) => option.name) }
          : {}),
      }),
    ),
  ].join('\n');
}

/**
 * Turns the model answer into the value the custom property type expects, or undefined when there is nothing valid to write.
 * Select answers are option names, stored as option ids. Dates are validated as calendar dates only and sent as ISO strings, as a future date is fine for a property such as an expiry date.
 */
export function toCustomPropertyValue({
  property,
  value,
}: {
  property: PropertyDefinition;
  value: unknown;
}) {
  if (value === null || value === undefined) {
    return undefined;
  }

  const optionIdsByName = new Map(property.options.map((option) => [option.name, option.id]));

  switch (property.type) {
    case CUSTOM_PROPERTY_TYPES.DATE:
      // The date type input is an ISO string, as sent by the API
      return typeof value === 'string' ? parseCalendarDate({ value })?.toISOString() : undefined;
    case CUSTOM_PROPERTY_TYPES.SELECT:
      return optionIdsByName.get(value as string);
    case CUSTOM_PROPERTY_TYPES.MULTI_SELECT: {
      const optionIds = (Array.isArray(value) ? (value as string[]) : [])
        .map((name) => optionIdsByName.get(name))
        .filter((id) => id !== undefined);
      return optionIds.length > 0 ? optionIds : undefined;
    }
    case CUSTOM_PROPERTY_TYPES.TEXT:
      return typeof value === 'string' && value.trim().length === 0 ? undefined : value;
    default:
      return value;
  }
}

// A choice question accepts up to 255 options, and one of them is the `none` option
const MAX_DECISION_SELECT_OPTIONS = 254;
const NO_OPTION_KEY = 'none';

const isDecidableProperty = (property: PropertyDefinition) =>
  property.type === CUSTOM_PROPERTY_TYPES.BOOLEAN ||
  (property.type === CUSTOM_PROPERTY_TYPES.SELECT &&
    property.options.length <= MAX_DECISION_SELECT_OPTIONS);

const describeProperty = (property: PropertyDefinition) =>
  `"${property.name}"${property.description ? ` (${property.description})` : ''}`;

// Select and boolean properties are closed questions, the rest stays with the language model. Keys are property positions, never user-written strings.
export function getCustomPropertiesDecisionQuestions(customProperties: EnrichmentCustomProperties) {
  return Object.fromEntries(
    getEligibleProperties(customProperties).flatMap((property, index) => {
      if (!isDecidableProperty(property)) {
        return [];
      }

      return [
        [
          `property_${index}`,
          property.type === CUSTOM_PROPERTY_TYPES.BOOLEAN
            ? boolean({
                instructions: `Does the document clearly state that the property ${describeProperty(property)} is true?`,
              })
            : choice({
                instructions: `Which option does the document clearly state for the property ${describeProperty(property)}?`,
                options: {
                  ...Object.fromEntries(
                    property.options.map((option, optionIndex) => [
                      `option_${optionIndex}`,
                      option.name,
                    ]),
                  ),
                  [NO_OPTION_KEY]: 'The document does not clearly state any of the options',
                },
              }),
        ],
      ];
    }),
  );
}

/**
 * Writes the clearly answered properties, a clear `none` leaves a select empty. Everything else stays for the language model.
 */
export function resolveCustomPropertiesDecisions({
  answers,
  customProperties,
}: {
  answers: Record<string, DecisionAnswer>;
  customProperties: EnrichmentCustomProperties;
}): DecisionOutcome<ReturnType<typeof getCustomPropertiesResponseSchema>> {
  const values: Record<string, boolean | string> = {};
  const decidedIds = new Set<string>();

  getEligibleProperties(customProperties).forEach((property, index) => {
    const answer = answers[`property_${index}`];

    if (!answer) {
      return;
    }

    if (answer.type === 'boolean') {
      if (isClearYes(answer.probability) || isClearNo(answer.probability)) {
        values[property.key] = isClearYes(answer.probability);
        decidedIds.add(property.id);
      }
      return;
    }

    if (!isClearYes(answer.probability)) {
      return;
    }

    decidedIds.add(property.id);

    if (answer.value !== NO_OPTION_KEY) {
      values[property.key] = property.options[Number(answer.value.replace('option_', ''))]!.name;
    }
  });

  const remaining = {
    ...customProperties,
    definitions: customProperties.definitions.filter(({ id }) => !decidedIds.has(id)),
  };

  return {
    response: { customProperties: values },
    isSettled: getEligibleProperties(remaining).length === 0,
    customProperties: remaining,
  };
}
