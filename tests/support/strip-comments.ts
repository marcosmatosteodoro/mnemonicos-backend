/**
 * Remove comentários de bloco e de linha de um texto-fonte TypeScript — usado
 * pelas provas estruturais/de ausência que ancoram numa CHAMADA real de
 * código, nunca numa menção em prosa dentro de um comentário. Helper único
 * (perfil node-22.md §7, "Fixtures compartilhadas"): reusado por
 * `production-events.service.integration.test.ts` e
 * `content-versions.service.integration.test.ts`.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
