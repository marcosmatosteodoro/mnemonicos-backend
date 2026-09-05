/**
 * Material de estudo — Direito Tributário / Obrigação Tributária (F2,
 * NFR-005-003, PLAN-006 §3 COMP-006-010).
 *
 * Mesmo padrão de `seed-admin.ts`/`seed-dev-editor.ts`: **sem** chamada de
 * topo (nenhum `main()`/efeito colateral na importação), para ser
 * exercitável contra o Postgres real sem rodar a carga inteira. Importar
 * este módulo nunca escreve no banco por si só — só a chamada explícita de
 * `seedMaterial` escreve. `authorId` vem de quem chama (o ADMIN é assunto do
 * bootstrap em `seed-admin.ts`, não deste laço).
 *
 * **Não é puramente aditiva**: `removeLegacyDisciplines` apaga Direito
 * Administrativo/Constitucional (A-005-011) e cascateia até
 * `CardState`/`Review` de estudante — guardada para nunca rodar em produção
 * (`isProduction`, injetável para teste, default `env.NODE_ENV === 'production'`).
 */
import { env } from '../src/config/env';
import type { NormativeSourceType, ProofRadarClass } from '../src/domain/types';
import type { PrismaClient } from '../src/generated/prisma/client';

interface RuleBreakdownSeed {
  concept: string;
  action: string;
  object: string;
  condition?: string;
  exception?: string;
  essence: string;
}

interface RawContentSeed {
  rawText: string;
  radarClass: ProofRadarClass;
  sourceType?: NormativeSourceType;
  sourceCitation?: string;
  sourceUrl?: string;
  breakdown: RuleBreakdownSeed;
}

interface TopicSeed {
  name: string;
  slug: string;
  rawContents: RawContentSeed[];
}

interface DisciplineSeed {
  name: string;
  slug: string;
  topics: TopicSeed[];
}

/**
 * Direito Tributário — Obrigação Tributária. Substitui o material de Direito
 * Administrativo/Constitucional (A-005-011, `removeLegacyDisciplines`
 * abaixo) — não coexistem.
 */
const DISCIPLINES: DisciplineSeed[] = [
  {
    name: 'Direito Tributário',
    slug: 'direito-tributario',
    topics: [
      {
        name: 'Obrigação Tributária Principal e Acessória',
        slug: 'obrigacao-tributaria-principal-e-acessoria',
        rawContents: [
          {
            rawText:
              'A obrigação tributária principal surge com a ocorrência do fato gerador, tem por objeto o pagamento de tributo ou penalidade pecuniária e extingue-se juntamente com o crédito dela decorrente. A obrigação acessória decorre da legislação tributária e tem por objeto as prestações, positivas ou negativas, nela previstas no interesse da arrecadação ou da fiscalização dos tributos.',
            radarClass: 'ALTA',
            sourceType: 'CTN',
            sourceCitation: 'CTN, art. 113, §§ 1º a 3º',
            breakdown: {
              concept: 'Obrigação tributária principal e acessória',
              action:
                'Distinguir o dever de pagar (principal) do dever de fazer/não fazer/tolerar no interesse da fiscalização (acessória)',
              object:
                'Pagamento de tributo ou penalidade pecuniária (principal); prestações de interesse da arrecadação ou fiscalização (acessória)',
              condition:
                'A obrigação acessória existe independentemente de haver obrigação principal correspondente',
              exception:
                'O descumprimento da acessória converte-se em obrigação principal relativamente à penalidade pecuniária (CTN, art. 113, § 3º)',
              essence:
                'Toda obrigação tributária nasce da lei ou da legislação tributária, nunca da vontade das partes.',
            },
          },
        ],
      },
      { name: 'Fato Gerador', slug: 'fato-gerador', rawContents: [] },
      { name: 'Sujeito Ativo e Passivo', slug: 'sujeito-ativo-e-passivo', rawContents: [] },
      { name: 'Solidariedade Tributária', slug: 'solidariedade-tributaria', rawContents: [] },
      { name: 'Responsabilidade Tributária', slug: 'responsabilidade-tributaria', rawContents: [] },
      { name: 'Domicílio Tributário', slug: 'domicilio-tributario', rawContents: [] },
    ],
  },
];

/** Disciplinas de exemplo substituídas por F2 (A-005-011) — não coexistem com Direito Tributário. */
const LEGACY_DISCIPLINE_SLUGS = ['direito-administrativo', 'direito-constitucional'];

/**
 * Remove o material de exemplo anterior (Direito Administrativo/Constitucional)
 * caso ainda exista de uma carga anterior à F2. `onDelete: Cascade` de
 * `Topic`/`Mnemonic`/`Flashcard` até `Discipline` faz o resto descer junto.
 * No-op quando já removido (idempotente).
 *
 * **Nunca roda em produção**: sem esta guarda, um `DATABASE_URL` de
 * staging/produção perderia dado de estudante (`CardState`/`Review`
 * cascateiam junto) a cada `npm run db:seed` — contraria a regra do projeto
 * de nunca alterar estrutura/dado silenciosamente.
 */
async function removeLegacyDisciplines(client: PrismaClient, isProduction: boolean): Promise<void> {
  if (isProduction) return;
  await client.discipline.deleteMany({ where: { slug: { in: LEGACY_DISCIPLINE_SLUGS } } });
}

interface SeedMaterialOptions {
  authorId: string;
  /** Injetável para teste; default `env.NODE_ENV === 'production'`. */
  isProduction?: boolean;
}

/**
 * Laço disciplina → tema → `RawContent` → `RuleBreakdown` do material de
 * estudo. Chave natural para idempotência: `RawContent` por
 * `(topicId, rawText)`; `RuleBreakdown` por `rawContentId` (`@unique`).
 */
export async function seedMaterial(
  client: PrismaClient,
  { authorId, isProduction = env.NODE_ENV === 'production' }: SeedMaterialOptions,
): Promise<void> {
  await removeLegacyDisciplines(client, isProduction);

  for (const discipline of DISCIPLINES) {
    const savedDiscipline = await client.discipline.upsert({
      where: { slug: discipline.slug },
      update: { name: discipline.name },
      create: { name: discipline.name, slug: discipline.slug },
    });

    for (const topic of discipline.topics) {
      const savedTopic = await client.topic.upsert({
        where: { disciplineId_slug: { disciplineId: savedDiscipline.id, slug: topic.slug } },
        update: { name: topic.name },
        create: { disciplineId: savedDiscipline.id, name: topic.name, slug: topic.slug },
      });

      for (const rawContent of topic.rawContents) {
        const existing = await client.rawContent.findFirst({
          where: { topicId: savedTopic.id, rawText: rawContent.rawText },
          select: { id: true },
        });

        const sourceFields = {
          sourceType: rawContent.sourceType ?? null,
          sourceCitation: rawContent.sourceCitation ?? null,
          sourceUrl: rawContent.sourceUrl ?? null,
        };

        const savedRawContent = existing
          ? await client.rawContent.update({
              where: { id: existing.id },
              data: { authorId, radarClass: rawContent.radarClass, ...sourceFields },
            })
          : await client.rawContent.create({
              data: {
                topicId: savedTopic.id,
                authorId,
                rawText: rawContent.rawText,
                radarClass: rawContent.radarClass,
                ...sourceFields,
              },
            });

        const breakdownFields = {
          concept: rawContent.breakdown.concept,
          action: rawContent.breakdown.action,
          object: rawContent.breakdown.object,
          condition: rawContent.breakdown.condition ?? null,
          exception: rawContent.breakdown.exception ?? null,
          essence: rawContent.breakdown.essence,
        };

        await client.ruleBreakdown.upsert({
          where: { rawContentId: savedRawContent.id },
          update: breakdownFields,
          create: { rawContentId: savedRawContent.id, ...breakdownFields },
        });
      }
    }
  }
}
