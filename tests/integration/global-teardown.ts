/**
 * `globalTeardown` do runner de integração.
 *
 * Cada arquivo `*.integration.test.ts` abre o seu `testPrisma` no sandbox da suíte
 * e o encerra no `afterAll` (via `closeTestDb`) — é lá que os pools de conexão
 * vivem e morrem (perfil §7: setup/teardown por arquivo). Este hook roda no
 * processo principal do Jest, que não mantém conexão aberta; existe como ponto de
 * parada único do runner e para deixar explícito que o banco `mnemonicos_test`
 * **não** é dropado (ver `global-setup.ts`).
 *
 * Não importa `./db`: os hooks globais são transpilados sem o `moduleNameMapper`
 * do config, então puxar o client gerado pelo Prisma aqui quebra a resolução dos
 * imports `.js` internos dele.
 */
export default function globalTeardown(): void {
  // Nada a encerrar neste processo.
}
