import express from 'express';
import request from 'supertest';

import type { AuthContext } from '../../src/modules/auth/auth.service';
import type { StrategicPanelPayload } from '../../src/modules/strategic-panel/strategic-panel-calculations';
import {
  strategicPanelRoutes,
  toStrategicPanelResponse,
} from '../../src/modules/strategic-panel/strategic-panel.routes';
import { buildStrategicPanel } from '../../src/modules/strategic-panel/strategic-panel.service';

jest.mock('../../src/modules/strategic-panel/strategic-panel.service');

const mockedBuildStrategicPanel = jest.mocked(buildStrategicPanel);

/**
 * `toStrategicPanelResponse` — allowlist prova-se sem depender do payload
 * ATUAL: um payload com 1 chave extra em CADA nível (via cast, nunca o tipo
 * real de `StrategicPanelPayload`/`ContentMetrics`) não pode chegar à saída —
 * a função monta campo a campo, nunca por spread. 2 mutantes distintos, 2
 * testes distintos: o teste de função (abaixo) mata `return payload;` no
 * corpo de `toStrategicPanelResponse`; o teste de rota (mais abaixo) mata
 * `res.json(payload)` direto no handler — a função pura sobreviveria intacta
 * a esse 2º mutante, só a montagem HTTP real o alcança.
 */

const EXTRA_KEY = 'leakedField';

function buildPoisonedPayload(): StrategicPanelPayload {
  return {
    [EXTRA_KEY]: 'nível raiz',
    contents: [
      {
        [EXTRA_KEY]: 'nível content',
        contentId: 'content-1',
        disciplineName: 'Direito Tributário',
        topicName: 'Obrigação Tributária',
        totalTime: { [EXTRA_KEY]: 'ramo medido', ms: 1000, pageCount: 10 },
        timePerPage: 100,
        perStage: {
          CONTEUDO_BRUTO: {
            [EXTRA_KEY]: 'ramo medido',
            status: 'medido',
            ms: 500,
            msPerPage: 50,
          },
          QUEBRA_DA_REGRA: { [EXTRA_KEY]: 'ramo não-medido', status: 'nao-percorrida' },
          TIRA_MNEMONICA: { status: 'nao-percorrida' },
          ASSOCIACAO_VISUAL: { status: 'nao-percorrida' },
          PUBLICACAO_PDF: { status: 'em-aberto' },
          MATERIAL_REFORCO: { status: 'nao-percorrida' },
          VERSAO_EDITORIAL: { status: 'sem-duracao-medida' },
          APROVACAO_VERSAO: { status: 'nao-percorrida' },
        },
        reworkCountByStage: { [EXTRA_KEY]: 1 },
        concluded: false,
        approvedButAltered: false,
        mostAdvancedStage: 'CONTEUDO_BRUTO',
        priority: 'MEDIA',
        ageMs: 1000,
      },
    ],
    factory: {
      [EXTRA_KEY]: 'nível factory',
      timePerPage: {
        [EXTRA_KEY]: 'ramo medido',
        status: 'medido',
        average: 1,
        median: 1,
        n: 1,
        activeTotal: 1,
      },
    },
    modules: [
      {
        [EXTRA_KEY]: 'nível module',
        disciplineName: 'Direito Tributário',
        topicName: 'Obrigação Tributária',
        timePerPage: { status: 'sem-medida', n: 0, activeTotal: 1 },
        completion: { [EXTRA_KEY]: 'nível completion', active: 1, concluded: 0 },
      },
    ],
    rework: {
      [EXTRA_KEY]: 'nível rework',
      byStage: { [EXTRA_KEY]: 1 },
      contentsWithCorrection: 0,
    },
    backlog: [
      {
        [EXTRA_KEY]: 'nível backlog item',
        contentId: 'content-1',
        disciplineName: 'Direito Tributário',
        topicName: 'Obrigação Tributária',
        mostAdvancedStage: 'CONTEUDO_BRUTO',
        priority: 'MEDIA',
        ageMs: 1000,
        approvedButAltered: false,
      },
    ],
  } as unknown as StrategicPanelPayload;
}

function collectKeysRecursively(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysRecursively(item, acc);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      acc.add(key);
      collectKeysRecursively(nested, acc);
    }
  }
}

describe('toStrategicPanelResponse — allowlist prova-se sem depender do payload atual', () => {
  it('payload com 1 chave extra em CADA nível (raiz, content, totalTime, perStage, factory, timePerPage, module, completion, rework, backlog) → nenhuma chega à saída', () => {
    const response = toStrategicPanelResponse(buildPoisonedPayload());

    const allKeys = new Set<string>();
    collectKeysRecursively(response, allKeys);

    expect(allKeys.has(EXTRA_KEY)).toBe(false);
  });
});

/**
 * Monta a rota real (`strategicPanelRoutes`) num app mínimo — `buildStrategicPanel`
 * mockado devolve o payload envenenado direto na fronteira HTTP. `requireRole` só
 * lê `req.auth` (já anexado por `requireAuth` na app real); aqui um middleware
 * injeta a sessão EDITOR sem passar pela autenticação real, suficiente para
 * alcançar o handler.
 */
function buildAppWithEditorSession(): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    const auth: AuthContext = { userId: 'editor-1', role: 'EDITOR', sessionId: 'session-1' };
    req.auth = auth;
    next();
  });
  app.use(strategicPanelRoutes);
  return app;
}

describe('GET /strategic-panel — allowlist na fronteira HTTP real', () => {
  it('serviço devolve payload envenenado (chave extra em todo nível) → resposta HTTP não carrega nenhuma', async () => {
    mockedBuildStrategicPanel.mockResolvedValue(buildPoisonedPayload());
    const app = buildAppWithEditorSession();

    const res = await request(app).get('/strategic-panel');

    expect(res.status).toBe(200);
    const allKeys = new Set<string>();
    collectKeysRecursively(res.body, allKeys);
    expect(allKeys.has(EXTRA_KEY)).toBe(false);
  });
});
