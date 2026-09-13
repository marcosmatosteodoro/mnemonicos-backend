import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';
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

  // COMP-023-017 (EMENDA/F5): `MulterError` não estende `AppError` (é lançado pelo
  // `multer`, biblioteca de terceiro) — ramo próprio, na MESMA posição relativa do
  // `ZodError` acima (antes do fallback genérico). `code === 'LIMIT_FILE_SIZE'` é o
  // único mapeado para 413 (NFR-022-004); qualquer outro código do multer (ex.:
  // `LIMIT_FIELD_VALUE`, `LIMIT_UNEXPECTED_FILE`) vira 400 genérico. Nunca `err.field`
  // nem stack no corpo — o nome do campo interno do multer não é seguro para expor.
  if (err instanceof MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const body: ErrorBody = {
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message:
          status === 413
            ? 'Arquivo enviado excede o tamanho máximo permitido.'
            : 'Requisição multipart inválida.',
      },
    };

    res.status(status).json(body);
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
