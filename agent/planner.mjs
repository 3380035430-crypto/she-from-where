const TASKS = new Set(['propose', 'open', 'advance', 'end', 'compile']);

const plans = {
  propose: { action: 'OFFER_SCENARIOS', context: 'character, category, expectation, excludedProposalSummaries' },
  open: { action: 'GENERATE_SCENE', context: 'character, category, scenario, expectation' },
  advance: { action: 'ADVANCE_STORY', context: 'character, category, scenario, current route only, selectedAction1' },
  end: { action: 'END_STORY', context: 'character, category, scenario, current route only, selectedAction1, selectedAction2' },
  compile: { action: 'GENERATE_COMPLETE_STORY', context: 'character, category, scenario, one completed route only' },
};

export function planTask(task, input = {}) {
  if (!TASKS.has(task)) throw new Error(`Unsupported story task: ${task}`);
  const plan = plans[task];
  return {
    task,
    action: plan.action,
    context: plan.context,
    input,
    next: task === 'propose' ? 'open' : task === 'open' ? 'advance' : task === 'advance' ? 'end' : task === 'end' ? 'compile' : 'done',
  };
}

export function supportedTasks() {
  return [...TASKS];
}
