/**
 * Entrypoint da Vercel. Uma app Express é um request handler, então basta
 * exportá-la; o `vercel.json` reescreve todas as rotas para cá.
 *
 * O `src/server.ts` continua sendo o entrypoint para execução local ou em
 * qualquer host que rode um processo longo (Docker, Railway, Render).
 */
import { app } from '../src/app';

export default app;
