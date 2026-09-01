/**
 * Ambiente dos testes de integração. **Deriva** de `setup-env.ts` (perfil §7: o
 * env de integração sobrepõe, nunca copia) — assim uma chave de ambiente nova
 * entra num lugar só. A única diferença: aqui a conexão com o Postgres é
 * **real**, contra o banco descartável `mnemonicos_test` do `docker-compose.yml`.
 * `DATABASE_URL` (runtime, via driver adapter) e `DIRECT_URL` (migrate) apontam
 * ambos para esse banco; `db-url.ts` valida o alvo na carga (ver lá).
 */
import './setup-env';

import { TEST_DATABASE_URL } from './integration/db-url';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DIRECT_URL = TEST_DATABASE_URL;
