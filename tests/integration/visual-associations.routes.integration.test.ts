import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import { createUser } from '../support/production-events-fixtures';
import {
  createVisualAssociation as seedVisualAssociation,
  PNG_FIXTURE_BUFFER as PNG_FIXTURE,
} from '../support/visual-association-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `visual-associations.routes.ts` (TASK-023-008, COMP-023-005/006/017) ponta-a-ponta
 * sobre a `app` **real** (`createApp()`, sem popular `ROUTE_ROLES` à mão) e o Postgres
 * real (harness de TASK-003-016). Fatia sensível (princípio 8): upload + assinatura de
 * bytes + guarda de autoria — gate 8 no fecho da wave.
 *
 * A topologia adversarial das 2 rotas (papéis declarados, chaves independentes,
 * censo 25→27 pares) vive em `route-authz-matrix.integration.test.ts` — não duplicada
 * aqui, exceto a faceta comportamental de STUDENT/anônimo (AC-022-014), que É desta
 * suíte porque a matriz genérica só cobre 401 (todo NON_PUBLIC) e 403-ADMIN-only
 * (nenhuma das 2 rotas novas é ADMIN-only).
 */

/**
 * Prefixos de magic bytes reais (mesmos usados em `image-signature.test.ts` e
 * `visual-association-storage.integration.test.ts`) — bastam para `detectImageSignature`
 * (que só inspeciona o cabeçalho), não são arquivos decodificáveis inteiros. `PNG_FIXTURE`
 * é `PNG_FIXTURE_BUFFER` de `tests/support/visual-association-fixtures.ts`.
 */
const JPEG_FIXTURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_FIXTURE = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
/** SVG real (texto/XML) renomeado `.png` — caso literal de AC-022-002. */
const SVG_AS_PNG_FIXTURE = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'utf-8',
);
/** Sem assinatura nenhuma — nem raster, nem SVG. */
const RANDOM_FIXTURE = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

const RASTER_FORMATS: Array<{ format: string; buffer: Buffer; mimeType: string }> = [
  { format: 'PNG', buffer: PNG_FIXTURE, mimeType: 'image/png' },
  { format: 'JPEG', buffer: JPEG_FIXTURE, mimeType: 'image/jpeg' },
  { format: 'WEBP', buffer: WEBP_FIXTURE, mimeType: 'image/webp' },
];

const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

/** A app como o cliente a alcança — mesma composição real de `src/app.ts`. */
const app = createApp();

/** Sessão viva do usuário `userId`; devolve o valor em claro do cookie de acesso. */
async function seedSession(userId: string): Promise<string> {
  const access = generateToken();
  await testPrisma.session.create({
    data: {
      userId,
      familyId: randomUUID(),
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(generateToken()),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return access;
}

function withCookie(access: string): [string, string] {
  return ['Cookie', `${ACCESS_COOKIE}=${access}`];
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
  // A rota usa o client de produção (`src/lib/prisma.ts`), que durante a integração
  // aponta para o banco descartável.
  await prisma.$disconnect();
});

describe('AC-022-001 (cobre FR-022-001, NFR-022-001): upload com assinatura de bytes válida cria a associação', () => {
  it.each(RASTER_FORMATS)(
    'POST /visual-associations com arquivo $format válido → 201, linha persistida com imageData/mimeType corretos',
    async ({ buffer, mimeType }) => {
      const editor = await createUser('EDITOR');
      const access = await seedSession(editor.id);

      const res = await request(app)
        .post('/api/v1/visual-associations')
        .set(...withCookie(access))
        .field('category', 'Tributário')
        .field('cognitiveDescription', 'Ilustra o fato gerador.')
        .attach('image', buffer, 'imagem.png');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        category: 'Tributário',
        cognitiveDescription: 'Ilustra o fato gerador.',
        mimeType,
        authorId: editor.id,
      });
      expect(res.body).not.toHaveProperty('imageData');

      const row = await testPrisma.visualAssociation.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.mimeType).toBe(mimeType);
      expect(Buffer.compare(Buffer.from(row.imageData), buffer)).toBe(0);
    },
  );
});

describe('AC-022-002 (cobre FR-022-002, NFR-022-001, NFR-022-002): assinatura de bytes inválida recusa o upload', () => {
  it.each([
    ['SVG renomeado .png (texto/XML)', SVG_AS_PNG_FIXTURE],
    ['arquivo aleatório sem assinatura nenhuma', RANDOM_FIXTURE],
  ])('%s → 400, motivo informado, NENHUMA linha criada', async (_label, buffer) => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const before = await testPrisma.visualAssociation.count();

    const res = await request(app)
      .post('/api/v1/visual-associations')
      .set(...withCookie(access))
      .field('category', 'Tributário')
      .field('cognitiveDescription', 'Ilustra o fato gerador.')
      .attach('image', buffer, 'imagem.png');

    expect(res.status).toBe(400);
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message.length).toBeGreaterThan(0);

    const after = await testPrisma.visualAssociation.count();
    expect(after).toBe(before);
  });
});

describe('AC-022-003 (cobre FR-022-003, NFR-022-004): arquivo acima do teto configurado', () => {
  /** 1 byte acima do teto — magic bytes de PNG válidas, só o TAMANHO é o motivo da recusa. */
  const oversizedRaster = Buffer.concat([
    PNG_FIXTURE,
    Buffer.alloc(env.VISUAL_ASSOCIATIONS_MAX_FILE_SIZE_BYTES + 1 - PNG_FIXTURE.length),
  ]);

  it('POST com arquivo raster válido acima do teto → 413, corpo sem stack nem nome de campo interno do multer, nada persistido', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const before = await testPrisma.visualAssociation.count();

    const res = await request(app)
      .post('/api/v1/visual-associations')
      .set(...withCookie(access))
      .field('category', 'Tributário')
      .field('cognitiveDescription', 'Ilustra o fato gerador.')
      .attach('image', oversizedRaster, 'imagem.png');

    expect(res.status).toBe(413);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    expect(JSON.stringify(res.body)).not.toMatch(/field|stack|multer/i);

    const after = await testPrisma.visualAssociation.count();
    expect(after).toBe(before);
  });

  it('PATCH com arquivo raster válido acima do teto → 413, mesma faceta, associação existente permanece intocada', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const existing = await seedVisualAssociation(editor.id);

    const res = await request(app)
      .patch(`/api/v1/visual-associations/${existing.id}`)
      .set(...withCookie(access))
      .attach('image', oversizedRaster, 'imagem.png');

    expect(res.status).toBe(413);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    expect(JSON.stringify(res.body)).not.toMatch(/field|stack|multer/i);

    const untouched = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(untouched.mimeType).toBe('image/png');
    expect(Buffer.compare(Buffer.from(untouched.imageData), PNG_FIXTURE)).toBe(0);
  });
});

describe('Limites de multipart além do arquivo (achado do security-engineer, gate 8 da Wave 1)', () => {
  it('campo category com payload muito maior que 4096 bytes → multipart recusado (400 via a EMENDA do error-handler.ts), nunca aceito silenciosamente', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const before = await testPrisma.visualAssociation.count();
    const oversizedCategory = 'a'.repeat(5000);

    const res = await request(app)
      .post('/api/v1/visual-associations')
      .set(...withCookie(access))
      .field('category', oversizedCategory)
      .field('cognitiveDescription', 'Ilustra o fato gerador.')
      .attach('image', PNG_FIXTURE, 'imagem.png');

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    expect(JSON.stringify(res.body)).not.toMatch(/field|stack|multer/i);

    const after = await testPrisma.visualAssociation.count();
    expect(after).toBe(before);
  });
});

describe('Teto de tamanho de category/cognitiveDescription cobre a via JSON, não só multipart', () => {
  it('PATCH com Content-Type: application/json e category acima do teto → 422, associação existente permanece intocada', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const existing = await seedVisualAssociation(editor.id);
    const oversizedCategory = 'a'.repeat(501);

    const res = await request(app)
      .patch(`/api/v1/visual-associations/${existing.id}`)
      .set(...withCookie(access))
      .send({ category: oversizedCategory });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const untouched = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(untouched.category).toBe(existing.category);
  });
});

describe('AC-022-004 (cobre FR-022-004): categoria/descrição ausentes', () => {
  it.each([
    ['sem category', { cognitiveDescription: 'Ilustra o fato gerador.' }],
    ['sem cognitiveDescription', { category: 'Tributário' }],
    ['sem os dois', {}],
  ])('%s → 422, campos pendentes indicados, nenhuma linha criada', async (_label, fields) => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const before = await testPrisma.visualAssociation.count();

    let req = request(app)
      .post('/api/v1/visual-associations')
      .set(...withCookie(access))
      .attach('image', PNG_FIXTURE, 'imagem.png');
    for (const [key, value] of Object.entries(fields)) {
      req = req.field(key, value);
    }
    const res = await req;

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);

    const after = await testPrisma.visualAssociation.count();
    expect(after).toBe(before);
  });

  it('sem arquivo (campo image ausente) → 400, nenhuma linha criada (FR-022-004: a imagem também é obrigatória)', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const before = await testPrisma.visualAssociation.count();

    const res = await request(app)
      .post('/api/v1/visual-associations')
      .set(...withCookie(access))
      .field('category', 'Tributário')
      .field('cognitiveDescription', 'Ilustra o fato gerador.');

    expect(res.status).toBe(400);
    const after = await testPrisma.visualAssociation.count();
    expect(after).toBe(before);
  });
});

describe('AC-022-006 (parte — persistência via PATCH, sem criar nova entidade)', () => {
  it('edita category, cognitiveDescription e substitui a imagem (3 variações) — PATCH responde com o MESMO id, leitura direta confirma os campos', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const original = await seedVisualAssociation(editor.id);

    const editCategory = await request(app)
      .patch(`/api/v1/visual-associations/${original.id}`)
      .set(...withCookie(access))
      .field('category', 'Categoria nova');
    expect(editCategory.status).toBe(200);
    expect(editCategory.body.id).toBe(original.id);
    expect(editCategory.body.category).toBe('Categoria nova');
    // `select` explícito (achado do security-engineer, gate 8 da Wave 1): a resposta de
    // PATCH nunca contém o binário.
    expect(editCategory.body).not.toHaveProperty('imageData');

    const editDescription = await request(app)
      .patch(`/api/v1/visual-associations/${original.id}`)
      .set(...withCookie(access))
      .field('cognitiveDescription', 'Descrição nova.');
    expect(editDescription.status).toBe(200);
    expect(editDescription.body.id).toBe(original.id);
    expect(editDescription.body.cognitiveDescription).toBe('Descrição nova.');

    const replaceImage = await request(app)
      .patch(`/api/v1/visual-associations/${original.id}`)
      .set(...withCookie(access))
      .attach('image', JPEG_FIXTURE, 'imagem.jpg');
    expect(replaceImage.status).toBe(200);
    expect(replaceImage.body.id).toBe(original.id);
    expect(replaceImage.body.mimeType).toBe('image/jpeg');

    const persisted = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(persisted.category).toBe('Categoria nova');
    expect(persisted.cognitiveDescription).toBe('Descrição nova.');
    expect(persisted.mimeType).toBe('image/jpeg');
    expect(Buffer.compare(Buffer.from(persisted.imageData), JPEG_FIXTURE)).toBe(0);
  });
});

describe('Contrato do item (DEC-023-012): authorId espúrio nunca vence o autor real', () => {
  it('POST com category + cognitiveDescription + authorId (3 campos) → 400 (LIMIT_FIELD_COUNT via a EMENDA do error-handler.ts), nenhuma linha criada com o authorId injetado', async () => {
    const editor = await createUser('EDITOR');
    const other = await createUser('EDITOR');
    const access = await seedSession(editor.id);

    const res = await request(app)
      .post('/api/v1/visual-associations')
      .set(...withCookie(access))
      .field('category', 'Tributário')
      .field('cognitiveDescription', 'Ilustra o fato gerador.')
      .field('authorId', other.id)
      .attach('image', PNG_FIXTURE, 'imagem.png');

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    expect(JSON.stringify(res.body)).not.toMatch(/field|stack|multer/i);

    const rowsForOther = await testPrisma.visualAssociation.count({
      where: { authorId: other.id },
    });
    expect(rowsForOther).toBe(0);
  });

  it('PATCH multipart com exatamente category + authorId (2 campos, dentro do teto fields:2) → 200, authorId da linha permanece o autor original', async () => {
    const editor = await createUser('EDITOR');
    const other = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const existing = await seedVisualAssociation(editor.id);

    const res = await request(app)
      .patch(`/api/v1/visual-associations/${existing.id}`)
      .set(...withCookie(access))
      .field('category', 'Categoria via multipart')
      .field('authorId', other.id);

    expect(res.status).toBe(200);
    expect(res.body.authorId).toBe(editor.id);

    const row = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(row.authorId).toBe(editor.id);
  });

  it('PATCH com Content-Type: application/json e { category, authorId } → 200, authorId da linha permanece o autor original', async () => {
    const editor = await createUser('EDITOR');
    const other = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const existing = await seedVisualAssociation(editor.id);

    const res = await request(app)
      .patch(`/api/v1/visual-associations/${existing.id}`)
      .set(...withCookie(access))
      .send({ category: 'Categoria via JSON', authorId: other.id });

    expect(res.status).toBe(200);
    expect(res.body.authorId).toBe(editor.id);

    const row = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(row.authorId).toBe(editor.id);
  });
});

describe('Guarda de escrita — mutação contável (assertVisualAssociationWritable, DEC-023-006, decisão 4.139/4.232)', () => {
  it('EDITOR B (outro autor) tenta PATCH → 403 com a mesma mensagem literal de recusa de escrita; linha permanece INTOCADA; ADMIN, no mesmo cenário, edita com sucesso (AC-022-020, parte)', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const association = await seedVisualAssociation(editorA.id);
    const accessB = await seedSession(editorB.id);
    const accessAdmin = await seedSession(admin.id);

    const before = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: association.id },
    });

    const deniedRes = await request(app)
      .patch(`/api/v1/visual-associations/${association.id}`)
      .set(...withCookie(accessB))
      .field('category', 'Tentativa de EDITOR B');

    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.error.message).toBe(
      'Você não tem permissão para alterar esta associação visual.',
    );

    const untouched = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: association.id },
    });
    expect(untouched.category).toBe(before.category);
    expect(untouched.cognitiveDescription).toBe(before.cognitiveDescription);
    expect(untouched.mimeType).toBe(before.mimeType);

    const adminRes = await request(app)
      .patch(`/api/v1/visual-associations/${association.id}`)
      .set(...withCookie(accessAdmin))
      .field('category', 'Editado pelo ADMIN');

    expect(adminRes.status).toBe(200);
    expect(adminRes.body.category).toBe('Editado pelo ADMIN');
  });

  it('PATCH sobre id inexistente → 404 (necessário para a guarda ter o que ler; contrato próprio de updateVisualAssociation)', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);

    const res = await request(app)
      .patch(`/api/v1/visual-associations/${randomUUID()}`)
      .set(...withCookie(access))
      .field('category', 'Categoria nova');

    expect(res.status).toBe(404);
  });
});

describe('AC-022-014 (parte — POST/PATCH recusados a STUDENT/anônimo)', () => {
  it('POST sem sessão → 401; sessão STUDENT → 403', async () => {
    const anon = await request(app)
      .post('/api/v1/visual-associations')
      .field('category', 'Tributário')
      .field('cognitiveDescription', 'Ilustra o fato gerador.')
      .attach('image', PNG_FIXTURE, 'imagem.png');
    expect(anon.status).toBe(401);

    const student = await createUser('STUDENT');
    const accessStudent = await seedSession(student.id);
    const asStudent = await request(app)
      .post('/api/v1/visual-associations')
      .set(...withCookie(accessStudent))
      .field('category', 'Tributário')
      .field('cognitiveDescription', 'Ilustra o fato gerador.')
      .attach('image', PNG_FIXTURE, 'imagem.png');
    expect(asStudent.status).toBe(403);
  });

  it('PATCH sem sessão → 401; sessão STUDENT → 403', async () => {
    const author = await createUser('EDITOR');
    const association = await seedVisualAssociation(author.id);

    const anon = await request(app)
      .patch(`/api/v1/visual-associations/${association.id}`)
      .field('category', 'Nova categoria');
    expect(anon.status).toBe(401);

    const student = await createUser('STUDENT');
    const accessStudent = await seedSession(student.id);
    const asStudent = await request(app)
      .patch(`/api/v1/visual-associations/${association.id}`)
      .set(...withCookie(accessStudent))
      .field('category', 'Nova categoria');
    expect(asStudent.status).toBe(403);
  });
});
