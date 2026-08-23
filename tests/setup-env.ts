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
