import { describe, expect, test } from 'vitest';
import { parseCalendarDate, parseDocumentDate } from './date.models';

const now = new Date('2026-03-15T10:00:00.000Z');

describe('parsing an AI suggested document date', () => {
  test('a date written as YYYY-MM-DD is stored at noon UTC so it shows the same day in most timezones', () => {
    expect(parseDocumentDate({ value: '2024-03-15', now })).toEqual(
      new Date('2024-03-15T12:00:00.000Z'),
    );
  });

  test.each([
    '15/03/2024',
    '2024-3-5',
    '2024-03-15T00:00:00.000Z',
    ' 2024-03-15',
    'March 15, 2024',
    '',
  ])('a date in the wrong format (%j) is ignored', (value) => {
    expect(parseDocumentDate({ value, now })).toEqual(undefined);
  });

  test.each(['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-10'])(
    'an impossible date (%s) is ignored instead of rolling over',
    (value) => {
      expect(parseDocumentDate({ value, now })).toEqual(undefined);
    },
  );

  test('a leap day is accepted in a leap year', () => {
    expect(parseDocumentDate({ value: '2024-02-29', now })).toEqual(
      new Date('2024-02-29T12:00:00.000Z'),
    );
  });

  test.each(['1899-12-31', '0050-01-01', '0000-01-01'])(
    'a date before 1900 (%s) is ignored',
    (value) => {
      expect(parseDocumentDate({ value, now })).toEqual(undefined);
    },
  );

  test('the first day of 1900 is accepted', () => {
    expect(parseDocumentDate({ value: '1900-01-01', now })).toEqual(
      new Date('1900-01-01T12:00:00.000Z'),
    );
  });

  test('a date after today is ignored', () => {
    expect(parseDocumentDate({ value: '2026-03-16', now })).toEqual(undefined);
  });

  test('today is accepted', () => {
    expect(parseDocumentDate({ value: '2026-03-15', now })).toEqual(
      new Date('2026-03-15T12:00:00.000Z'),
    );
  });

  test('a null suggestion gives no date', () => {
    expect(parseDocumentDate({ value: null, now })).toEqual(undefined);
  });
});

describe('parsing an AI suggested calendar date', () => {
  test('a future date is valid, as for an expiry date, but an impossible or too old one is not', () => {
    expect(parseCalendarDate({ value: '2099-12-31' })).toEqual(
      new Date('2099-12-31T12:00:00.000Z'),
    );
    expect(parseCalendarDate({ value: '2026-02-30' })).toEqual(undefined);
    expect(parseCalendarDate({ value: '1899-12-31' })).toEqual(undefined);
  });
});
