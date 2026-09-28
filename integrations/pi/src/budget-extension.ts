import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { budgetGuidance } from '../../../src/engine/budget.ts';
import type { BudgetState } from '../../../src/engine/budget.ts';
/** Native context hook, not a second loop. Admission remains enforced in the engine. */
export function createBudgetExtension(state: () => BudgetState): ExtensionFactory {
  return pi => { pi.on('context', event => {
    const budget = state();
    pi.appendEntry('mergewarden.budget-state.v1', budget);
    return { messages: [...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'mergewarden.budget.v1')),
      { role: 'custom' as const, customType: 'mergewarden.budget.v1', content: budgetGuidance(budget), display: false, timestamp: Date.now() }] };
  }); };
}
