/**
 * Seed — idempotente, pode rodar quantas vezes quiser.
 *
 * Duas partes independentes: o bootstrap do primeiro ADMIN (a partir de
 * `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, sem senha embutida — FR-002-021) e o
 * material de estudo. O bootstrap roda primeiro: se `SEED_ADMIN_PASSWORD` estiver
 * com o placeholder do `.env.example`, `seedAdmin` lança e a carga inteira aborta.
 */
import { prisma } from '../src/lib/prisma';
import type { MnemonicTechnique } from '../src/domain/types';
import { type AdminSeedOutcome, seedAdmin } from './seed-admin';

interface MnemonicSeed {
  technique: MnemonicTechnique;
  hook: string;
  decoding: string;
  source?: string;
  flashcards: { front: string; back: string }[];
}

interface TopicSeed {
  name: string;
  slug: string;
  mnemonics: MnemonicSeed[];
}

interface DisciplineSeed {
  name: string;
  slug: string;
  topics: TopicSeed[];
}

const DISCIPLINES: DisciplineSeed[] = [
  {
    name: 'Direito Administrativo',
    slug: 'direito-administrativo',
    topics: [
      {
        name: 'Princípios da Administração Pública',
        slug: 'principios-da-administracao-publica',
        mnemonics: [
          {
            technique: 'ACRONYM',
            hook: 'LIMPE',
            decoding:
              'Legalidade, Impessoalidade, Moralidade, Publicidade, Eficiência — os cinco princípios expressos.',
            source: 'CF/88, art. 37, caput',
            flashcards: [
              {
                front: 'Quais são os princípios expressos da Administração Pública?',
                back: 'LIMPE: Legalidade, Impessoalidade, Moralidade, Publicidade e Eficiência (art. 37 da CF/88).',
              },
              {
                front: 'Qual princípio do LIMPE foi incluído pela EC 19/1998?',
                back: 'A Eficiência — o "E" do LIMPE é o mais novo.',
              },
            ],
          },
        ],
      },
      {
        name: 'Atos Administrativos',
        slug: 'atos-administrativos',
        mnemonics: [
          {
            technique: 'ACRONYM',
            hook: 'COM-FI-FOR-MO-OB',
            decoding:
              'Competência, Finalidade, Forma, Motivo e Objeto — os cinco elementos do ato administrativo.',
            flashcards: [
              {
                front: 'Quais são os elementos do ato administrativo?',
                back: 'Competência, Finalidade, Forma, Motivo e Objeto.',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Direito Constitucional',
    slug: 'direito-constitucional',
    topics: [
      {
        name: 'Objetivos Fundamentais da República',
        slug: 'objetivos-fundamentais-da-republica',
        mnemonics: [
          {
            technique: 'ACROSTIC',
            hook: 'Construir, Garantir, Erradicar, Promover',
            decoding:
              'Construir uma sociedade livre, justa e solidária; Garantir o desenvolvimento nacional; Erradicar a pobreza e a marginalização; Promover o bem de todos.',
            source: 'CF/88, art. 3º',
            flashcards: [
              {
                front: 'Quais são os quatro objetivos fundamentais da República (art. 3º)?',
                back: 'Construir, Garantir, Erradicar e Promover — os verbos abrem cada inciso.',
              },
            ],
          },
        ],
      },
    ],
  },
];

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

async function main() {
  reportAdminSeed(await seedAdmin(prisma));

  for (const discipline of DISCIPLINES) {
    const savedDiscipline = await prisma.discipline.upsert({
      where: { slug: discipline.slug },
      update: { name: discipline.name },
      create: { name: discipline.name, slug: discipline.slug },
    });

    for (const topic of discipline.topics) {
      const savedTopic = await prisma.topic.upsert({
        where: { disciplineId_slug: { disciplineId: savedDiscipline.id, slug: topic.slug } },
        update: { name: topic.name },
        create: { disciplineId: savedDiscipline.id, name: topic.name, slug: topic.slug },
      });

      for (const mnemonic of topic.mnemonics) {
        // Sem chave natural para mnemônico: o par (assunto, gancho) faz esse papel.
        const existing = await prisma.mnemonic.findFirst({
          where: { topicId: savedTopic.id, hook: mnemonic.hook },
          select: { id: true },
        });

        const savedMnemonic = existing
          ? await prisma.mnemonic.update({
              where: { id: existing.id },
              data: {
                technique: mnemonic.technique,
                decoding: mnemonic.decoding,
                source: mnemonic.source ?? null,
              },
            })
          : await prisma.mnemonic.create({
              data: {
                topicId: savedTopic.id,
                technique: mnemonic.technique,
                hook: mnemonic.hook,
                decoding: mnemonic.decoding,
                source: mnemonic.source ?? null,
              },
            });

        for (const card of mnemonic.flashcards) {
          const existingCard = await prisma.flashcard.findFirst({
            where: { topicId: savedTopic.id, front: card.front },
            select: { id: true },
          });

          if (existingCard) {
            await prisma.flashcard.update({
              where: { id: existingCard.id },
              data: { back: card.back, mnemonicId: savedMnemonic.id },
            });
            continue;
          }

          await prisma.flashcard.create({
            data: {
              topicId: savedTopic.id,
              mnemonicId: savedMnemonic.id,
              front: card.front,
              back: card.back,
            },
          });
        }
      }
    }
  }

  const [disciplines, topics, mnemonics, flashcards] = await Promise.all([
    prisma.discipline.count(),
    prisma.topic.count(),
    prisma.mnemonic.count(),
    prisma.flashcard.count(),
  ]);

  console.log(
    `seed concluído — ${disciplines} disciplinas, ${topics} assuntos, ${mnemonics} mnemônicos, ${flashcards} cartões`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('seed falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
