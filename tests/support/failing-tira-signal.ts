/**
 * Envolve um client de transação Prisma (`tx`) num `Proxy` cujo
 * `productionStageEvent.findFirst` sempre rejeita — todo o resto é delegado
 * ao `tx` real via `Reflect.get`. Usado para provar o fail-secure de
 * `resolveAlterationSignal` (o sinal de alteração da Tira mnemônica) sem
 * espionar o client Prisma raiz (`prisma`), que não é o objeto realmente
 * usado dentro do `$transaction` — helper único (perfil node-22.md §7),
 * reusado por `content-versions.service.integration.test.ts` e
 * `publication.service.integration.test.ts`.
 */
export function withFailingTiraSignal<T extends object>(tx: T): T {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === 'productionStageEvent') {
        const real = Reflect.get(target, prop, target) as Record<string, unknown>;
        return new Proxy(real, {
          get(innerTarget, innerProp) {
            if (innerProp === 'findFirst') {
              return () => Promise.reject(new Error('falha simulada na leitura do sinal'));
            }
            return Reflect.get(innerTarget, innerProp, innerTarget) as unknown;
          },
        });
      }
      return Reflect.get(target, prop, target);
    },
  });
}
