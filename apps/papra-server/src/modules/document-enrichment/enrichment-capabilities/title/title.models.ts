import { getExtension } from '../../../shared/files/file-names';

// Matches the limit of the documents API (`name` is at most 255 characters)
const MAX_DOCUMENT_NAME_LENGTH = 255;
export const MAX_TITLE_LENGTH = 150;

const SURROUNDING_QUOTES_REGEX = /^["'`“”‘’«»]+|["'`“”‘’«»]+$/g;

// A leading dot (".bashrc") is a hidden file, not an extension
function getOriginalExtension({ originalName }: { originalName: string }) {
  const { extension } = getExtension({ fileName: originalName });

  return originalName.lastIndexOf('.') > 0 && extension && /^[\da-z]{1,10}$/i.test(extension)
    ? extension
    : undefined;
}

function truncateOnCodePoint({ text, maxLength }: { text: string; maxLength: number }) {
  let truncated = '';

  for (const char of text) {
    if (truncated.length + char.length > maxLength) {
      break;
    }
    truncated += char;
  }

  return truncated.trim();
}

/**
 * Turns an AI suggested title into a safe document name that keeps the original file extension.
 * Returns undefined when the suggestion gives nothing usable.
 */
export function buildDocumentNameFromTitle({
  title,
  originalName,
}: {
  title: string | null;
  originalName: string;
}) {
  const extension = getOriginalExtension({ originalName });
  const suffix = extension ? `.${extension}` : '';

  let cleanTitle = (title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SURROUNDING_QUOTES_REGEX, '')
    .trim();

  if (suffix && cleanTitle.toLowerCase().endsWith(suffix.toLowerCase())) {
    cleanTitle = cleanTitle.slice(0, -suffix.length).trim();
  }

  cleanTitle = truncateOnCodePoint({
    text: cleanTitle,
    maxLength: Math.min(MAX_TITLE_LENGTH, MAX_DOCUMENT_NAME_LENGTH - suffix.length),
  });

  return cleanTitle === '' ? undefined : `${cleanTitle}${suffix}`;
}
