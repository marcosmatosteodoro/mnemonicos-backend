/**
 * Seed — idempotente, pode rodar quantas vezes quiser.
 *
 * Runner fino: chama três funções puras, cada uma sem efeito de topo (nenhum
 * `main()` embutido nos módulos que ela importa) — `seedAdmin` (ADMIN a
 * partir de `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, sem senha embutida,
 * FR-002-021), `seedMaterial` (Direito Tributário/Obrigação Tributária,
 * F2/NFR-005-003) e `seedDevEditor` (EDITOR de dev, sujeito do gate 9 das
 * telas). O bootstrap do ADMIN roda primeiro: se `SEED_ADMIN_PASSWORD`
 * estiver com o placeholder do `.env.example`, `seedAdmin` lança e a carga
 * inteira aborta. Sem ADMIN (env ausente/parcial), o material é pulado —
 * `RawContent` exige `authorId` (coluna `NOT NULL`, FK `Restrict`).
 *
 * Só este arquivo é executável como script (`tsx prisma/seed.ts` /
 * `npm run db:seed`); `seed-admin.ts`, `seed-material.ts` e
 * `seed-dev-editor.ts` só exportam funções — importá-los não escreve no
 * banco. É por isso que o teste de integração importa `seedMaterial` de
 * `./seed-material` e nunca de `./seed`: importar este arquivo executaria a
 * carga real, contra o `.env` de verdade (`main()` abaixo é chamado no topo).
 */
import { prisma } from '../src/lib/prisma';
import { type AdminSeedOutcome, seedAdmin } from './seed-admin';
import { type DevEditorSeedOutcome, seedDevEditor } from './seed-dev-editor';
import { seedMaterial } from './seed-material';

function reportAdminSeed(outcome: AdminSeedOutcome): void {
  switch (outcome.status) {
    case 'created':
      console.log(`seed do ADMIN — primeiro ADMIN criado a partir do env (${outcome.email})`);
      break;
    case 'exists':
      console.log('seed do ADMIN — já existe um ADMIN, nada a criar');
      break;
    case 'partial':
      console.log(
        'seed do ADMIN — só uma de SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD definida; tratado como ausente, nenhum ADMIN criado',
      );
      break;
    case 'not-configured':
      console.log(
        'seed do ADMIN — SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD ausentes, nenhum ADMIN criado',
      );
      break;
  }
}

function reportDevEditorSeed(outcome: DevEditorSeedOutcome): void {
  switch (outcome.status) {
    case 'created':
      console.log(`seed do EDITOR de dev — criado a partir do env (${outcome.email})`);
      break;
    case 'exists':
      console.log('seed do EDITOR de dev — já existe um usuário com este e-mail, nada a criar');
      break;
    case 'partial':
      console.log(
        'seed do EDITOR de dev — só uma de SEED_EDITOR_EMAIL/SEED_EDITOR_PASSWORD definida; tratado como ausente',
      );
      break;
    case 'not-configured':
      console.log(
        'seed do EDITOR de dev — SEED_EDITOR_EMAIL/SEED_EDITOR_PASSWORD ausentes, nenhum EDITOR criado',
      );
      break;
  }
}

/**
 * Resolve o id do ADMIN semeado a partir do desfecho de `seedAdmin`, para
 * servir de `authorId` a `seedMaterial`. `created` já traz o e-mail; `exists`
 * consulta o ADMIN já presente (pode não ser o do env deste run).
 */
async function resolveAdminId(outcome: AdminSeedOutcome): Promise<string | null> {
  if (outcome.status === 'not-configured' || outcome.status === 'partial') return null;

  const admin =
    outcome.status === 'created'
      ? await prisma.user.findUnique({ where: { email: outcome.email }, select: { id: true } })
      : await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });

  return admin?.id ?? null;
}

async function main() {
  const adminOutcome = await seedAdmin(prisma);
  reportAdminSeed(adminOutcome);

  const adminId = await resolveAdminId(adminOutcome);

  if (adminId) {
    await seedMaterial(prisma, { authorId: adminId });
  } else {
    console.log(
      'seed do material — nenhum ADMIN disponível (env de bootstrap ausente/parcial), pulando a carga de Direito Tributário',
    );
  }

  reportDevEditorSeed(await seedDevEditor(prisma));

  const [disciplines, topics, rawContents, ruleBreakdowns] = await Promise.all([
    prisma.discipline.count(),
    prisma.topic.count(),
    prisma.rawContent.count(),
    prisma.ruleBreakdown.count(),
  ]);

  console.log(
    `seed concluído — ${disciplines} disciplinas, ${topics} assuntos, ${rawContents} conteúdos brutos, ${ruleBreakdowns} quebras da regra`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('seed falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
