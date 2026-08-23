import { Router } from 'express';

import { disciplinesRoutes } from '../modules/disciplines/disciplines.routes';
import { healthRoutes } from '../modules/health/health.routes';

/** Todas as rotas da API sob um único prefixo versionado. */
export const apiRoutes = Router();

apiRoutes.use(healthRoutes);
apiRoutes.use(disciplinesRoutes);
