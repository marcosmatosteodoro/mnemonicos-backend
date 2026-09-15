import { AppError, GenerationTimeoutError } from '../../src/http/errors';

describe('GenerationTimeoutError', () => {
  it('tem statusCode 503', () => {
    expect(new GenerationTimeoutError().statusCode).toBe(503);
  });

  it('tem code GENERATION_TIMEOUT', () => {
    expect(new GenerationTimeoutError().code).toBe('GENERATION_TIMEOUT');
  });

  it('tem mensagem default de timeout de geração', () => {
    expect(new GenerationTimeoutError().message).toBe(
      'A geração do documento demorou demais. Tente novamente.',
    );
  });

  it('é instância de AppError', () => {
    expect(new GenerationTimeoutError()).toBeInstanceOf(AppError);
  });
});
