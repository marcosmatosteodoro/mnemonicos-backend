import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { isTest } from '../../config/env';
import { TooManyRequestsError } from '../../http/errors';
import { recordAuthEvent } from '../../lib/audit';

/**
 * Freio de taxa dedicado a `POST /auth/login` — chave composta conta + origem
 * (DEC-003-006 / FR-002-008 / NFR-002-006 / A-002-020). Dois `express-rate-limit`
 * independentes:
 *
 *  - **por conta**: chaveado pelo e-mail tentado (normalizado), teto estrito —
 *    contém força bruta dirigida a um alvo, seguindo o alvo por qualquer origem;
 *  - **por origem**: chaveado por `req.ip`, teto frouxo — calibrado para não
 *    deter uma equipe interna atrás de um único IP de escritório (A-002-020).
 *
 * Ambos mais estritos que o limite global da API (`src/app.ts`: 300 / 15 min),
 * resposta 429 + `Retry-After` (o `Retry-After` é posto pelo próprio
 * `express-rate-limit` porque `standardHeaders` está ligado), **sem** bloqueio
 * duro de conta em nenhum eixo — passada a janela, a conta volta a tentar.
 *
 * O contador é em memória, por instância (TRISK-003-001): proteção real
 * multi-instância exige store compartilhado — dívida conhecida, fora do escopo
 * de F1. Montagem na rota é de TASK-003-009; aqui só se exporta o array.
 *
 * `trust proxy` numérico (`app.set('trust proxy', 1)` em `src/app.ts`) é o que
 * torna `req.ip` confiável — `express-rate-limit` reprova `trust proxy: true`
 * (perfil §6.3).
 */

/** Janela de contagem dos dois freios — igual à do limite global da API. */
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Teto ESTRITO por conta tentada (e-mail normalizado), em uma janela.
 * Afinável — se o uso real mostrar erro, vira variável de ambiente (DEC-003-006);
 * enquanto o PLAN não pede env, fica constante nomeada.
 */
export const LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX = 5;

/**
 * Teto FROUXO por origem (`req.ip`), em uma janela. Mais alto que o de conta
 * para acomodar a equipe atrás de um IP compartilhado, ainda bem abaixo do
 * teto global da API.
 */
export const LOGIN_RATE_LIMIT_PER_ORIGIN_MAX = 30;

/** Balde usado quando a requisição chega sem e-mail no corpo (não autentica de todo modo). */
const ANONYMOUS_ACCOUNT_KEY = 'anonymous';

/**
 * E-mail tentado, normalizado como o `loginSchema` (trim + minúsculas), lido do
 * corpo já parseado. O freio roda antes do `schema.parse`, então a normalização
 * é refeita aqui. `req.body` é `any` no Express — daí o estreitamento explícito.
 */
function attemptedAccount(req: Request): string {
  const body: unknown = req.body;

  if (body !== null && typeof body === 'object' && 'email' in body) {
    const email = (body as Record<string, unknown>).email;
    if (typeof email === 'string' && email.trim() !== '') {
      return email.trim().toLowerCase();
    }
  }

  return ANONYMOUS_ACCOUNT_KEY;
}

/**
 * Resposta comum ao disparo de qualquer um dos dois freios: audita o bloqueio
 * temporário (NFR-002-005 — evento plano, sem senha nem token) e delega ao
 * `errorHandler` (`src/http/middlewares/error-handler.ts`) via
 * `next(new TooManyRequestsError(...))` — a fronteira única de conversão de erro
 * monta o envelope 429 (perfil §5/§9). `outcome` é `'failure'`: o contrato
 * `AuthOutcome` (`src/lib/audit.ts`, Wave 2) só admite `'success' | 'failure'`,
 * e a tentativa foi recusada — o `type` `login.throttled` é o que marca
 * "bloqueio temporário". O `Retry-After` já foi posto pelo `express-rate-limit`
 * (`standardHeaders`) antes deste handler rodar; é header, não corpo, e sobrevive
 * ao `res.status().json()` do `errorHandler`.
 */
function throttleHandler(req: Request, _res: Response, next: NextFunction): void {
  recordAuthEvent({
    type: 'login.throttled',
    at: new Date(),
    outcome: 'failure',
    subject: attemptedAccount(req),
    ip: req.ip ?? 'desconhecida',
    userAgent: req.get('user-agent') ?? undefined,
  });

  next(
    new TooManyRequestsError('Muitas tentativas de login. Aguarde um instante e tente novamente.'),
  );
}

const defaultSkip = (): boolean => isTest;

/** Sobreposições de teste — nunca usadas em produção (a exportação pronta usa os defaults). */
export interface LoginRateLimiterOverrides {
  windowMs?: number;
  perAccountMax?: number;
  perOriginMax?: number;
  /** Desliga o `skip` de teste para exercitar o freio numa suíte sob `NODE_ENV=test`. */
  skip?: () => boolean;
}

/**
 * Constrói o par de freios. A exportação `loginRateLimiters` chama sem
 * argumentos; os testes passam `skip: () => false` e limiares baixos para
 * exercitar o comportamento sem depender dos defaults de produção.
 */
export function createLoginRateLimiters(
  overrides: LoginRateLimiterOverrides = {},
): RequestHandler[] {
  const windowMs = overrides.windowMs ?? LOGIN_RATE_LIMIT_WINDOW_MS;
  const skip = overrides.skip ?? defaultSkip;

  const perAccount = rateLimit({
    windowMs,
    limit: overrides.perAccountMax ?? LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip,
    keyGenerator: (req: Request) => attemptedAccount(req),
    handler: throttleHandler,
  });

  const perOrigin = rateLimit({
    windowMs,
    limit: overrides.perOriginMax ?? LOGIN_RATE_LIMIT_PER_ORIGIN_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip,
    // `ipKeyGenerator` normaliza IPv6 para /56 — sem ele, um cliente IPv6 fura o
    // freio trocando de endereço na mesma sub-rede (validação do próprio pacote).
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
    handler: throttleHandler,
  });

  return [perAccount, perOrigin];
}

/** Par pronto para montagem na rota (TASK-003-009): conta primeiro, origem depois. */
export const loginRateLimiters: RequestHandler[] = createLoginRateLimiters();
