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

```bash
cp .env.example .env         # preencha DATABASE_URL e gere um JWT_SECRET
npm install                  # dispara prisma generate + husky
npm run db:migrate           # cria o schema (precisa de um Postgres de pé)
npm run db:seed              # popula o acervo de exemplo
npm run dev                  # http://localhost:3333
```

Postgres local rápido, se precisar:

```bash
docker run --name mnemonicos-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mnemonicos -p 5432:5432 -d postgres:17
```

Gere o `JWT_SECRET` localmente e **não** o versione:

```bash
openssl rand -base64 48
```

## Scripts

| Script                 | O que faz                              |
| ---------------------- | -------------------------------------- |
| `npm run dev`          | `tsx watch` em `src/server.ts`         |
| `npm run build`        | `prisma generate` + `tsc` para `dist/` |
| `npm start`            | Roda o build                           |
| `npm run lint`         | ESLint (com type-checking)             |
| `npm run typecheck`    | `tsc --noEmit`                         |
| `npm run format:check` | Prettier em modo verificação           |
| `npm test`             | Jest                                   |
| `npm run test:ci`      | Jest com cobertura                     |
| `npm run validate`     | format:check + lint + typecheck + test |
| `npm run db:migrate`   | `prisma migrate dev`                   |
| `npm run db:deploy`    | `prisma migrate deploy` (produção)     |
| `npm run db:seed`      | Popula o acervo de exemplo             |
| `npm run db:studio`    | Prisma Studio                          |

## Estrutura

```
api/
└── index.ts                     # entrypoint da Vercel (exporta a app Express)
prisma/
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

- Build command: `vercel-build` (`prisma generate`) — detectado automaticamente.
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
As migrações não rodam no build da Vercel — aplique-as num passo próprio
(`npm run db:deploy`) antes de promover a versão.

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
