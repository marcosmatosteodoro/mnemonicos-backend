import {
  detectImageSignature,
  extensionForFormat,
  mimeTypeForFormat,
  type RasterImageFormat,
} from '../../src/modules/visual-associations/image-signature';

describe('detectImageSignature', () => {
  it('reconhece um PNG válido pela assinatura de bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

    expect(detectImageSignature(buffer)).toBe('PNG');
  });

  it('reconhece um JPEG válido pela assinatura de bytes', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    expect(detectImageSignature(buffer)).toBe('JPEG');
  });

  it('reconhece um WebP válido pela assinatura RIFF + WEBP no offset 8', () => {
    const buffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x00,
      0x00,
      0x00,
      0x00, // tamanho do chunk (irrelevante para a detecção)
      0x57,
      0x45,
      0x42,
      0x50, // "WEBP"
    ]);

    expect(detectImageSignature(buffer)).toBe('WEBP');
  });

  it('devolve null para um SVG renomeado .png (conteúdo textual, sem assinatura raster)', () => {
    const svgBuffer = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'utf-8',
    );

    expect(detectImageSignature(svgBuffer)).toBeNull();
  });

  it('devolve null sem lançar exceção para um arquivo truncado (menos bytes que o magic number mais longo)', () => {
    const truncated = Buffer.from([0x89, 0x50]);

    expect(() => detectImageSignature(truncated)).not.toThrow();
    expect(detectImageSignature(truncated)).toBeNull();
  });

  it('devolve null para um buffer com prefixo RIFF mas sem WEBP no offset 8 (ex.: WAV)', () => {
    const wavLikeBuffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE", não "WEBP"
    ]);

    expect(detectImageSignature(wavLikeBuffer)).toBeNull();
  });
});

describe('extensionForFormat', () => {
  it.each<[RasterImageFormat, string]>([
    ['PNG', '.png'],
    ['JPEG', '.jpg'],
    ['WEBP', '.webp'],
  ])('devolve %s -> %s', (format, expected) => {
    expect(extensionForFormat(format)).toBe(expected);
  });
});

describe('mimeTypeForFormat', () => {
  it.each<[RasterImageFormat, string]>([
    ['PNG', 'image/png'],
    ['JPEG', 'image/jpeg'],
    ['WEBP', 'image/webp'],
  ])('devolve %s -> %s', (format, expected) => {
    expect(mimeTypeForFormat(format)).toBe(expected);
  });
});
