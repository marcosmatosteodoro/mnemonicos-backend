import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { logger } from '../../lib/logger';
import { AppError, NotFoundError } from '../errors';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Rota não encontrada: ${req.method} ${req.path}`));
};

/**
 * Fail secure: só erros que a aplicação declarou como seguros viram resposta
 * detalhada. Qualquer outra coisa devolve 500 genérico — stack trace, mensagem
 * do driver do banco e nome de tabela ficam apenas no log do servidor.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    const body: ErrorBody = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos.',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };

    res.status(422).json(body);
    return;
  }

  if (err instanceof AppError) {
    // 5xx declarado ainda é falha nossa: registra.
    if (err.statusCode >= 500) {
      logger.error({ err, path: req.path }, 'erro de aplicação');
    }

    const body: ErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    };

    res.status(err.statusCode).json(body);
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'erro não tratado');

  const body: ErrorBody = {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Erro interno.',
    },
  };

  res.status(500).json(body);
};
