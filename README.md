# mnemonicos-backend

API do **Projeto Material Mnemônico de Alta Retenção para Concursos**.

Serve o acervo (disciplinas → assuntos → mnemônicos → flashcards) e guarda o
estado de repetição espaçada de cada estudante.

## Stack

| Camada    | Escolha                                    |
| --------- | ------------------------------------------ |
| Runtime   | Node 22                                    |
| Linguagem | TypeScript 6 (`strict`, CommonJS)          |
| HTTP      | Express 5                                  |
| Banco     | PostgreSQL via Prisma 7 (adapter `pg`)     |
| Validação | Zod 4                                      |
| Log       | pino + pino-http (com redação de segredos) |
| Testes    | Jest 30 + ts-jest + supertest              |
| Qualidade | ESLint 9 + typescript-eslint + Prettier 3  |
| Git hooks | Husky 9 + lint-staged 16                   |
| Deploy    | Vercel (function serverless)               |

## Rodando

Requisitos: Node 22 e Docker.

```bash
cp .env.example .env    # gere um JWT_SECRET; o resto já aponta para o container
npm install             # dispara prisma generate + husky
npm run db:setup        # sobe o Postgres, aplica as migrações e popula o acervo
npm run dev             # http://localhost:3333
```

Gere o `JWT_SECRET` localmente e **não** o versione:

```bash
openssl rand -base64 48
```

### O banco de desenvolvimento

O `docker-compose.yml` sobe um Postgres local. `npm run dev` **liga o banco
antes da aplicação** e só segue quando o healthcheck passa — o `--wait` do
`docker compose` garante isso, então a aplicação nunca tenta conectar num
Postgres que ainda está inicializando.

Se você já tem um Postgres próprio (ou quer apontar para um banco remoto), use
`npm run dev:no-db`: sobe só a aplicação, sem tocar em Docker.

```bash
npm run dev             # Postgres + aplicação
npm run dev:no-db       # só a aplicação
npm run db:up           # só o Postgres (espera ficar healthy)
npm run db:down         # para o container, preservando os dados
npm run db:destroy      # para e APAGA o volume — recomeça do zero
npm run db:psql         # abre um psql dentro do container
npm run db:logs         # segue o log do Postgres
```

Detalhes que valem saber:

- A porta é publicada em **`127.0.0.1:5432`**, não em `0.0.0.0` — o banco não
  fica exposto à rede local.
- O volume é montado em **`/var/lib/postgresql`**, não em `.../data`: a partir do
  Postgres 18 a imagem guarda os dados num subdiretório por versão maior, e o
  mount no caminho antigo faz o container subir _unhealthy_.
- As credenciais do container vêm de `POSTGRES_USER`/`POSTGRES_PASSWORD`/
  `POSTGRES_DB` no `.env`, com defaults para desenvolvimento. São de container
  descartável — não são segredo de produção, mas também não valem nada fora daqui.

## Scripts

| Script                 | O que faz                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run dev`          | Sobe o Postgres e depois a aplicação                                                                         |
| `npm run dev:no-db`    | Só a aplicação (`tsx watch`)                                                                                 |
| `npm run build`        | `prisma generate` + `tsc` para `dist/`                                                                       |
| `npm start`            | Roda o build                                                                                                 |
| `npm run vercel-build` | `prisma generate` + `prisma migrate deploy` — Build Command da Vercel, roda (e migra produção) a cada deploy |
| `npm run lint`         | ESLint (com type-checking)                                                                                   |
| `npm run typecheck`    | `tsc --noEmit`                                                                                               |
| `npm run format:check` | Prettier em modo verificação                                                                                 |
| `npm test`             | Jest                                                                                                         |
| `npm run test:ci`      | Jest com cobertura                                                                                           |
| `npm run validate`     | format:check + lint + typecheck + test                                                                       |
| `npm run db:setup`     | `db:up` + `db:deploy` + `db:seed`                                                                            |
| `npm run db:up`        | Sobe o Postgres e espera ficar healthy                                                                       |
| `npm run db:down`      | Para o container (mantém os dados)                                                                           |
| `npm run db:destroy`   | Para o container e apaga o volume                                                                            |
| `npm run db:psql`      | `psql` dentro do container                                                                                   |
| `npm run db:logs`      | Log do Postgres                                                                                              |
| `npm run db:migrate`   | `prisma migrate dev`                                                                                         |
| `npm run db:deploy`    | `prisma migrate deploy` (produção)                                                                           |
| `npm run db:seed`      | Popula o acervo de exemplo                                                                                   |
| `npm run db:studio`    | Prisma Studio                                                                                                |
| `npm run db:format`    | `prisma format` no schema                                                                                    |

## Estrutura

```
api/
└── index.ts                     # entrypoint da Vercel (exporta a app Express)
docker-compose.yml               # Postgres de desenvolvimento
prisma/
├── migrations/                  # histórico versionado do schema
├── schema.prisma                # modelo de dados
└── seed.ts                      # acervo de exemplo, idempotente
prisma.config.ts                 # config do CLI (URL do migrate)
src/
├── app.ts                       # monta a app: helmet, cors, rate limit, rotas
├── server.ts                    # listen + graceful shutdown (host tradicional)
├── config/env.ts                # validação das variáveis de ambiente com Zod
├── domain/types.ts              # uniões do domínio, espelhando os enums
├── http/
│   ├── errors.ts                # AppError e subclasses
│   ├── routes.ts                # agregador sob /api/v1
│   └── middlewares/
│       └── error-handler.ts     # 404 + tratamento central de erros
├── lib/
│   ├── logger.ts                # pino com redact
│   └── prisma.ts                # client único + driver adapter
└── modules/
    ├── disciplines/             # schema → service → routes
    ├── health/                  # liveness e readiness
    └── review/scheduler.ts      # agendamento SM-2 (função pura)
tests/
├── integration/                 # supertest sobre a app
├── unit/                        # lógica pura
└── setup-env.ts                 # env fictícia dos testes
```

## Endpoints

Todos sob o prefixo `/api/v1`.

| Método | Rota                               | O que faz                                  |
| ------ | ---------------------------------- | ------------------------------------------ |
| GET    | `/health`                          | Liveness — não toca em dependência         |
| GET    | `/health/db`                       | Readiness — confirma o Postgres            |
| GET    | `/disciplines?page&perPage&search` | Lista disciplinas com contagem de assuntos |

Erro sempre no mesmo envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "...", "details": [] } }
```

## Modelo de dados

```
Discipline ─┬─< Topic ─┬─< Mnemonic ─┬─< Flashcard ─┬─< CardState  (por usuário)
            │          │             │              └─< Review     (histórico)
            │          └─────────────────────────────< Flashcard
User ───────────────────────────────────────────────< CardState, Review
```

- **`Mnemonic`** guarda o gancho (`hook`) e o que ele decodifica (`decoding`),
  além da `technique` e da fonte/base legal.
- **`CardState`** é o estado presente da repetição espaçada, único por
  `(usuário, cartão)`. **`Review`** é o registro imutável de cada revisão — a
  série histórica que permite recalcular o algoritmo depois sem perder dados.

### Sobre o Prisma 7

A URL do banco não fica mais no `schema.prisma`:

- **runtime** → driver adapter (`@prisma/adapter-pg`) em `src/lib/prisma.ts`,
  usando `DATABASE_URL`;
- **migrate/studio** → `prisma.config.ts`, que prefere `DIRECT_URL`.

Os dois existem porque `prisma migrate` emite DDL que o pgbouncer não suporta:
`DATABASE_URL` aponta para o pooler, `DIRECT_URL` para a conexão direta.

O client é gerado em `src/generated/prisma` (fora do git) por `prisma generate`,
que roda no `postinstall` e no `build`.

## Segurança

O que já está no lugar:

- **Env validada na inicialização** (`src/config/env.ts`) — o processo não sobe
  com `DATABASE_URL` ausente ou `JWT_SECRET` curto. Em erro, só os **nomes** das
  variáveis aparecem, nunca os valores.
- **CORS deny-by-default** — allowlist explícita em `CORS_ORIGINS`; origem fora
  da lista recebe 403.
- **`helmet`** com os defaults (HSTS, `nosniff`, CSP, `X-Frame-Options`).
- **Rate limit** de 300 req / 15 min por IP, com `trust proxy` ajustado para a
  Vercel. É um contador em memória: por instância. Para proteção real em
  serverless, trocar por um store compartilhado (Redis).
- **Corpo limitado a 100 kB** — a API recebe texto, não upload.
- **Fail secure no error handler** — só `AppError` e `ZodError` viram resposta
  detalhada. Qualquer outra exceção devolve `500` genérico; stack trace,
  mensagem do driver e nome de tabela ficam apenas no log.
- **Log sem segredo** — `authorization`, `cookie`, `set-cookie`, `password`,
  `passwordHash`, `token`, `DATABASE_URL` e `JWT_SECRET` são redigidos pelo pino.
- **Consultas parametrizadas** — tudo pelo Prisma; nenhuma string SQL montada
  por concatenação.
- **`overrides` do `deepmerge-ts`** no `package.json` — corrige
  GHSA-ggr8-5vv4-36mx, que chega via `@prisma/config`, sem regredir o Prisma.

O que ainda **falta** e é pré-requisito antes de expor dados de usuário:

- Autenticação: hash de senha com **Argon2id** (ou bcrypt), emissão e
  verificação de JWT, refresh token.
- Autorização por recurso: `CardState` e `Review` são dados pessoais — toda
  consulta precisa filtrar por `userId` da sessão, não do parâmetro da rota.
- Auditoria de eventos de autenticação (sucesso, falha, bloqueio).

## Deploy (Vercel)

Projeto Vercel próprio apontando para este diretório. O `vercel.json` reescreve
todas as rotas para `api/index.ts`, que exporta a app Express.

- Build command: `vercel-build` (`prisma generate && prisma migrate deploy`) —
  apontado manualmente no painel da Vercel (Project Settings → Build & Development
  Settings → Build Command); não é o default do framework preset.
- Variáveis de ambiente (Production e Preview):

| Variável       | Observação                                                |
| -------------- | --------------------------------------------------------- |
| `NODE_ENV`     | `production`                                              |
| `DATABASE_URL` | **URL do pooler** (pgbouncer) — Neon, Supabase, RDS Proxy |
| `DIRECT_URL`   | Conexão direta, para `prisma migrate deploy`              |
| `JWT_SECRET`   | Gerado com `openssl rand -base64 48`                      |
| `CORS_ORIGINS` | Domínio do `mnemonicos-frontend`, sem barra final         |
| `LOG_LEVEL`    | `info`                                                    |

Marque `DATABASE_URL`, `DIRECT_URL` e `JWT_SECRET` como **Sensitive** no painel.
O `vercel-build` já aplica as migrações pendentes (`prisma migrate deploy`) a cada
deploy. O `prisma.config.ts` resolve a URL de migração como `DIRECT_URL ?? DATABASE_URL`:
sem `DIRECT_URL` nas env vars, o Prisma **não recusa** — cai silenciosamente na
`DATABASE_URL` do pooler e tenta rodar o DDL por ela, um caminho que o pgbouncer não
suporta e que nunca foi testado neste projeto. Preview e Production compartilhando o
mesmo banco significa que todo push de branch também migra produção; não há segregação
de ambiente hoje.

### Migração falha (P3009): destravando o deploy

Se uma migração falha em produção, o Prisma grava a linha como `FAILED` em
`_prisma_migrations`, e todo `migrate deploy` seguinte aborta com `P3009: migrate found
failed migrations in the target database, new migrations will not be applied`. Como o
`vercel-build` roda a cada deploy, isso trava a esteira inteira — inclusive um hotfix de
segurança — até a migração ser resolvida manualmente.

1. Identifique a migração falha: `npx prisma migrate status` (lê `DIRECT_URL`) lista o
   nome marcado como `FAILED`.
2. Resolva contra produção, rodando com `DIRECT_URL` no ambiente:
   `npx prisma migrate resolve --rolled-back <nome_da_migração>` se o efeito da migração
   não chegou a ficar aplicado, ou `--applied <nome_da_migração>` se ficou e só o
   registro em `_prisma_migrations` está inconsistente.
3. **Break-glass**: para destravar um deploy de emergência sem tocar o banco, aponte o
   Build Command do painel da Vercel para `npm run build` (não migra) até o passo 2 ser
   feito; depois volte para `npm run vercel-build`.

Para rodar em host tradicional (Docker, Railway, Render), o entrypoint é
`dist/server.js` via `npm start`; `api/index.ts` e `vercel.json` são ignorados.

## Convenções

- Arquivos em `kebab-case`, com sufixo de papel: `.routes.ts`, `.service.ts`,
  `.schema.ts`.
- Camadas por módulo: **schema** (validação) → **service** (regra + banco) →
  **routes** (HTTP). Nada de Prisma direto na rota.
- Express 5 encaminha promise rejeitada ao error handler: handler `async` não
  precisa de `try/catch` nem de wrapper.
- Lógica de negócio pura fica em função sem I/O — `scheduler.ts` recebe `now`
  por parâmetro justamente para ser testável sem relógio nem banco.
