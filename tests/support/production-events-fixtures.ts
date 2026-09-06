import { randomUUID } from 'node:crypto';

import type { UserRole } from '../../src/domain/types';
import { testPrisma } from '../integration/db';

/**
 * Fixtures compartilhadas dos testes de `ProductionStageEvent` (TASK-010-001/
 * TASK-010-002) — helper único (perfil node-22.md §7, "Fixtures
 * compartilhadas"), para uma coluna nova em `User`/`Topic`/`RawContent` não
 * quebrar cópias uma a uma.
 */
export async function createUser(role: UserRole = 'EDITOR') {
  return testPrisma.user.create({
    data: {
      email: `user-${randomUUID()}@example.com`,
      name: 'Usuária de fixture',
      passwordHash: 'irrelevante-para-este-teste',
      role,
    },
  });
}

export async function createTopic(): Promise<string> {
  const discipline = await testPrisma.discipline.create({
    data: { name: `Disciplina ${randomUUID()}`, slug: `disciplina-${randomUUID()}` },
  });
  const topic = await testPrisma.topic.create({
    data: {
      disciplineId: discipline.id,
      name: `Tema ${randomUUID()}`,
      slug: `tema-${randomUUID()}`,
    },
  });
  return topic.id;
}

export async function createRawContent(authorId: string, topicId: string) {
  return testPrisma.rawContent.create({
    data: {
      authorId,
      topicId,
      rawText: 'Art. 113 do CTN define a obrigação tributária.',
      radarClass: 'ALTA',
    },
  });
}
