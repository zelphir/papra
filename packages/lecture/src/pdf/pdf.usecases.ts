import type { Buffer } from 'node:buffer';
import type { PdfRawImage } from './pdf.types';
import sharp from 'sharp';
import { IMAGE_KIND, IMAGE_KIND_CHANNELS } from './pdf.constants';

export function getNormalizedImageData(image: PdfRawImage): Uint8Array {
  if (image.kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    // Unpack 1-bit per pixel (MSB first) into 8-bit grayscale: bit 1 = white (255), bit 0 = black (0)
    // PDF 1bpp scanlines are byte-aligned: each row occupies ceil(width/8) bytes,
    // with unused padding bits at the end of each row that must be skipped.
    const unpacked = new Uint8Array(image.width * image.height);
    const rowBytes = Math.ceil(image.width / 8);

    for (let y = 0; y < image.height; y++) {
      const rowOffset = y * rowBytes;
      for (let x = 0; x < image.width; x++) {
        const byte = image.data[rowOffset + (x >> 3)] ?? 0;
        unpacked[y * image.width + x] = (byte >> (7 - (x & 7))) & 1 ? 255 : 0;
      }
    }
    return unpacked;
  }

  return image.data;
}

// Phone scans embed small images that OCR reads poorly, so they are enlarged first
const OCR_UPSCALE_MAX_LONG_SIDE = 2000;
const OCR_UPSCALE_FACTOR = 3;

export async function pdfImageToBuffer(
  image: PdfRawImage,
  { rotation = 0 }: { rotation?: number } = {},
): Promise<Buffer> {
  const imageData = getNormalizedImageData(image);
  const isSideways = rotation % 180 !== 0;
  const scale =
    Math.max(image.width, image.height) < OCR_UPSCALE_MAX_LONG_SIDE ? OCR_UPSCALE_FACTOR : 1;

  return (
    sharp(imageData, {
      raw: {
        width: image.width,
        height: image.height,
        channels: IMAGE_KIND_CHANNELS[image.kind]!,
      },
    })
      // Rotation is the page's display rotation, embedded images are stored without it
      .rotate(rotation)
      .resize({ width: (isSideways ? image.height : image.width) * scale })
      // PDF image objects have no standalone DPI. Use Tesseract's 70 DPI fallback explicitly so
      // it does not emit an invalid-resolution warning when processing the generated PNG.
      // It's just a meta, doesn't affect the actual pixel data
      .withMetadata({ density: 70 })
      .png()
      .toBuffer()
  );
}
