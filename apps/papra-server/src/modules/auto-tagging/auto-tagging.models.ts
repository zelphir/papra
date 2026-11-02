import { TAG_NAME_MAX_LENGTH } from '../tags/tags.constants';
import { uniq, uniqBy } from '../shared/utils';

export type AutoTaggingResponse = {
  existingTags?: string[];
  newTags?: { name: string; description?: string }[];
};

export type AutoTaggingActions = {
  tagIdsToAdd: string[];
  tagsToCreate: { name: string; description?: string }[];
};

// Looser than the stored tag normalizedName on purpose: it only decides whether an AI suggestion duplicates a tag
function normalizeSuggestedTagName({ name }: { name: string }): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[-_\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

export function getTagsActions({
  autoTaggingResponse,
  existingTags,
  maxTags,
}: {
  autoTaggingResponse: AutoTaggingResponse;
  existingTags: { name: string; id: string }[];
  maxTags: number;
}): AutoTaggingActions {
  const { existingTags: requestedExistingTagNames = [], newTags = [] } = autoTaggingResponse;

  const existingTagNamesMap = new Map(existingTags.map((tag) => [tag.name, tag.id]));
  const existingTagIdsByNormalizedName = new Map(
    existingTags.map((tag) => [normalizeSuggestedTagName({ name: tag.name }), tag.id]),
  );

  const validNewTags = uniqBy(
    newTags
      .map((tag) => ({ ...tag, name: tag.name.trim() }))
      .filter(({ name }) => name.length > 0 && name.length <= TAG_NAME_MAX_LENGTH),
    ({ name }) => normalizeSuggestedTagName({ name }),
  );

  const matchedExistingTagIds = validNewTags
    .map(({ name }) => existingTagIdsByNormalizedName.get(normalizeSuggestedTagName({ name })))
    .filter(Boolean);

  const tagIdsToAdd = uniq([
    ...requestedExistingTagNames.map((tagName) => existingTagNamesMap.get(tagName)).filter(Boolean),
    ...matchedExistingTagIds,
  ]).slice(0, maxTags);

  const tagsToCreate = validNewTags
    .filter(({ name }) => !existingTagIdsByNormalizedName.has(normalizeSuggestedTagName({ name })))
    .slice(0, maxTags - tagIdsToAdd.length);

  return { tagIdsToAdd, tagsToCreate };
}
