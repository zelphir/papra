export const MAX_ENRICHMENT_CONTENT_LENGTH = 24_000;

const TRUNCATION_MARKER = '\n\n[... content truncated ...]\n\n';

function isHighSurrogate(charCode: number) {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}

export function truncateEnrichmentContent({ content }: { content: string }) {
  if (content.length <= MAX_ENRICHMENT_CONTENT_LENGTH) {
    return content;
  }

  const budget = MAX_ENRICHMENT_CONTENT_LENGTH - TRUNCATION_MARKER.length;
  let headLength = Math.ceil(budget / 2);
  let tailStart = content.length - Math.floor(budget / 2);

  // Do not cut a surrogate pair in half
  if (isHighSurrogate(content.charCodeAt(headLength - 1))) {
    headLength -= 1;
  }
  if (isHighSurrogate(content.charCodeAt(tailStart - 1))) {
    tailStart += 1;
  }

  return `${content.slice(0, headLength)}${TRUNCATION_MARKER}${content.slice(tailStart)}`;
}
