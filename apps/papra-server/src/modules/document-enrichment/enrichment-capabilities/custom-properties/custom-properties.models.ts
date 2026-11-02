import * as v from 'valibot';
import { CUSTOM_PROPERTY_TYPES } from '../../../custom-properties/custom-properties.constants';
import { parseCalendarDate } from '../date/date.models';
import type { EnrichmentCustomProperties } from '../enrichment-capabilities-definition';

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
  return v.object({
    customProperties: v.object(
      Object.fromEntries(
        properties.map((property) => [property.key, v.nullable(getPropertyValueSchema(property))]),
      ),
    ),
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
