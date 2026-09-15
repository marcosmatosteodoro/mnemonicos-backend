/**
 * Ambiente dos testes. Valores fictícios de propósito: o suite não abre conexão
 * real com o banco, e nenhum segredo de verdade entra no repositório.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '3333';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/mnemonicos_test?schema=public';
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

// Teto de upload da Biblioteca visual (F5/PLAN-023) — mesmo valor do `.env.example`,
// determinístico para os testes de tamanho (AC-022-003) computarem o excedente a partir dele.
process.env.VISUAL_ASSOCIATIONS_MAX_FILE_SIZE_BYTES = '5242880';

// Teto de duração da composição do PDF de publicação (F6/PLAN-025) — mesmo valor do
// `.env.example`, determinístico para os testes de timeout (AC-024-017) mockarem contra ele.
process.env.PUBLICATION_PDF_TIMEOUT_MS = '12000';
