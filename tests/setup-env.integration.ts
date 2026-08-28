/**
 * Ambiente dos testes de integração. Igual a `setup-env.ts` (valores fictícios,
 * nenhum segredo real, nenhum teste lê `.env`) com uma diferença: aqui a conexão
 * com o Postgres é **real**, contra o banco descartável `mnemonicos_test` do
 * `docker-compose.yml`. `DATABASE_URL` (runtime, via driver adapter) e
 * `DIRECT_URL` (migrate) apontam ambos para esse banco.
 */
import { TEST_DATABASE_URL } from './integration/db-url';

process.env.NODE_ENV = 'test';
process.env.PORT = '3333';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DIRECT_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'segredo-ficticio-de-teste-com-mais-de-32-chars';

// Chaves da fatia de acesso interno (COMP-003-001). Todas têm default no envSchema;
// fixadas aqui para tornar o ambiente de teste determinístico. As `.optional()`
// (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD) ficam ausentes de propósito.
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_ACCESS_TTL_MINUTES = '15';
process.env.AUTH_REFRESH_TTL_DAYS = '7';
process.env.AUTH_REFRESH_GRACE_SECONDS = '10';
process.env.ARGON2_MEMORY_KIB = '19456';
process.env.ARGON2_TIME_COST = '2';
process.env.ARGON2_PARALLELISM = '1';
