export const MAX_ENRICHMENT_CONTENT_LENGTH = 24_000;

// The decision model switches to a slower, less accurate mode above about 32,000 bytes, 10,000 characters stay under it even at 3 bytes each
export const MAX_DECISION_CONTENT_LENGTH = 10_000;

const TRUNCATION_MARKER = '\n\n[... content truncated ...]\n\n';

function isHighSurrogate(charCode: number) {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}

export function truncateEnrichmentContent({
  content,
  maxLength = MAX_ENRICHMENT_CONTENT_LENGTH,
}: {
  content: string;
  maxLength?: number;
}) {
  if (content.length <= maxLength) {
    return content;
  }

  const budget = maxLength - TRUNCATION_MARKER.length;
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
