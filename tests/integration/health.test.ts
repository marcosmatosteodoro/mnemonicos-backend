import request from 'supertest';

import { API_PREFIX, app } from '../../src/app';

describe(`GET ${API_PREFIX}/health`, () => {
  it('responde 200 sem tocar em dependência externa', async () => {
    const response = await request(app).get(`${API_PREFIX}/health`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', environment: 'test' });
    expect(typeof response.body.uptime).toBe('number');
  });

  it('não expõe o cabeçalho X-Powered-By', async () => {
    const response = await request(app).get(`${API_PREFIX}/health`);

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('aplica os cabeçalhos de segurança do helmet', async () => {
    const response = await request(app).get(`${API_PREFIX}/health`);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});

describe('rotas desconhecidas', () => {
  it('devolvem 404 com corpo de erro padronizado', async () => {
    const response = await request(app).get('/rota-que-nao-existe');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('CORS', () => {
  it('aceita origem presente na allowlist', async () => {
    const response = await request(app)
      .get(`${API_PREFIX}/health`)
      .set('Origin', 'http://localhost:3000');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('recusa origem fora da allowlist com 403', async () => {
    const response = await request(app)
      .get(`${API_PREFIX}/health`)
      .set('Origin', 'https://site-nao-autorizado.example.com');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});
