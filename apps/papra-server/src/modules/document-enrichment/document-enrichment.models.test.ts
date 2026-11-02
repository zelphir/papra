import { describe, expect, test } from 'vitest';
import {
  MAX_ENRICHMENT_CONTENT_LENGTH,
  truncateEnrichmentContent,
} from './document-enrichment.models';

describe('document enrichment models', () => {
  describe('truncateEnrichmentContent', () => {
    test('a document within the limit is sent to the model unchanged', () => {
      const content = 'a'.repeat(MAX_ENRICHMENT_CONTENT_LENGTH);

      expect(truncateEnrichmentContent({ content })).toEqual(content);
    });

    test('a longer document keeps its start and end, with a truncation marker in between, within the limit', () => {
      const content = `START${'a'.repeat(MAX_ENRICHMENT_CONTENT_LENGTH * 2)}END`;

      const result = truncateEnrichmentContent({ content });

      expect(result.length).toBeLessThanOrEqual(MAX_ENRICHMENT_CONTENT_LENGTH);
      expect(result.startsWith('START')).toEqual(true);
      expect(result.endsWith('END')).toEqual(true);
      expect(result).toContain('[... content truncated ...]');
    });

    test('truncation never splits an emoji into a lone surrogate', () => {
      for (const prefix of ['', 'a']) {
        const content = prefix + '😀'.repeat(MAX_ENRICHMENT_CONTENT_LENGTH);

        const result = truncateEnrichmentContent({ content });

        expect(result.length).toBeLessThanOrEqual(MAX_ENRICHMENT_CONTENT_LENGTH);
        expect(result.isWellFormed()).toEqual(true);
      }
    });
  });
});
