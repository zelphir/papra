import * as v from 'valibot';

export const documentEnrichmentCapabilitySchema = v.picklist([
  'auto-tagging',
  'title',
  'date',
  'custom-properties',
]);

export type DocumentEnrichmentCapability = v.InferOutput<typeof documentEnrichmentCapabilitySchema>;

// The model answers all capabilities in one request validated as a whole, so one invalid field must
// become empty instead of failing the response and losing the valid fields. The JSON schema sent to the provider is unchanged.
export const nullableOrNull = <TSchema extends v.GenericSchema>(schema: TSchema) =>
  v.fallback(v.nullable(schema), null);

export const enrichDocumentBodySchema = v.strictObject({
  capabilities: v.optional(v.pipe(v.array(documentEnrichmentCapabilitySchema), v.minLength(1))),
});
