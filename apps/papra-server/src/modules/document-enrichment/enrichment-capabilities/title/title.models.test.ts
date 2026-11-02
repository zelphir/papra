import { describe, expect, test } from 'vitest';
import { buildDocumentNameFromTitle, MAX_TITLE_LENGTH } from './title.models';

describe('building a document name from an AI title', () => {
  test.each([
    ['Electricity bill March 2024', 'SCAN_0001.pdf', 'Electricity bill March 2024.pdf'],
    ['  "Rental agreement"  ', 'scan.pdf', 'Rental agreement.pdf'],
    ['“Passport copy”', 'IMG_1.jpg', 'Passport copy.jpg'],
    ['Invoices/2024\\March', 'scan.pdf', 'Invoices 2024 March.pdf'],
    ['Tax\nreturn\t2023\u0000', 'scan.pdf', 'Tax return 2023.pdf'],
    ['Bank   statement', 'scan.pdf', 'Bank statement.pdf'],
  ])('cleans the title %j into a safe name', (title, originalName, expected) => {
    expect(buildDocumentNameFromTitle({ title, originalName })).toEqual(expected);
  });

  test('an extension added by the model is not duplicated, whatever its case', () => {
    expect(
      buildDocumentNameFromTitle({ title: 'Lease agreement.PDF', originalName: 'scan.pdf' }),
    ).toEqual('Lease agreement.pdf');
  });

  test('only the last extension of a dotted original name is kept', () => {
    expect(
      buildDocumentNameFromTitle({ title: 'Annual report', originalName: 'scan.v2.final.pdf' }),
    ).toEqual('Annual report.pdf');
  });

  test.each(['scan', 'scan.', '.hidden'])(
    'an original name without an extension (%j) gives a name without extension',
    (originalName) => {
      expect(buildDocumentNameFromTitle({ title: 'Meeting notes', originalName })).toEqual(
        'Meeting notes',
      );
    },
  );

  test.each([null, '', '   ', '"" ', '/\\', '.pdf'])('the title %j gives no change', (title) => {
    expect(buildDocumentNameFromTitle({ title, originalName: 'scan.pdf' })).toEqual(undefined);
  });

  test('an overlong title is cut so the final name, extension included, stays within limits', () => {
    const name = buildDocumentNameFromTitle({
      title: 'a'.repeat(1000),
      originalName: 'scan.pdf',
    })!;

    expect(name).toEqual(`${'a'.repeat(MAX_TITLE_LENGTH)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(255);
  });

  test('a long extension still leaves the final name within the API limit', () => {
    const name = buildDocumentNameFromTitle({
      title: 'a'.repeat(1000),
      originalName: 'scan.abcdefghij',
    })!;

    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.endsWith('.abcdefghij')).toEqual(true);
  });

  test('an emoji at the cut point is dropped whole instead of being split', () => {
    const name = buildDocumentNameFromTitle({
      title: `${'a'.repeat(MAX_TITLE_LENGTH - 1)}😀 tail`,
      originalName: 'scan.pdf',
    });

    expect(name).toEqual(`${'a'.repeat(MAX_TITLE_LENGTH - 1)}.pdf`);
  });
});
