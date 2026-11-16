// Invented planning inputs, separate from the joiner fixtures. No model was evaluated.
export function syntheticModelChoices() {
  return [
    { id: 'incumbent', name: 'Synthetic incumbent', calls: 200, cost_per_call: 0.04, tool_and_retry_cost: 2, assumed_correct_tasks: 99, explanation: 'Reference route. The invented cohort has 99 correct tasks out of 100.' },
    { id: 'cheap-a', name: 'Synthetic cheaper A', calls: 200, cost_per_call: 0.01, tool_and_retry_cost: 12, assumed_correct_tasks: 90, explanation: 'Lowest call price, but the invented workflow incurs extra tool/recovery expense and only 90 correct tasks. It is a worse full-task option.' },
    { id: 'cheap-b', name: 'Synthetic cheaper B', calls: 200, cost_per_call: 0.02, tool_and_retry_cost: 2, assumed_correct_tasks: 99, explanation: 'A plausible candidate for real evaluation: lower modeled total cost with the same assumed success count. These invented figures do not establish quality parity or authorize a route change.' },
  ].map(row => {
    const model_cost = row.calls * row.cost_per_call;
    const full_cost = model_cost + row.tool_and_retry_cost;
    return { ...row, attempted_tasks: 100, model_cost, full_cost,
      cost_per_correct_task: full_cost / row.assumed_correct_tasks,
      evidence: 'synthetic assumptions; no replay, verifier or holdout was run', route_change_allowed: false };
  });
}
