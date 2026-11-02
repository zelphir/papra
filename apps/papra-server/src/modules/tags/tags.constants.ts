import { createPrefixedIdRegex } from '../shared/random/ids.constants.models';

export const TagColorRegex = /^#[0-9A-F]{6}$/;

export const TAG_NAME_MAX_LENGTH = 64;

export const tagIdPrefix = 'tag';
export const tagIdRegex = createPrefixedIdRegex({ prefix: tagIdPrefix });
