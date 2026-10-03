export function createGenerator({ modelName, usesQwen, systemPrompt, enableThinking = () => false }) {
  async function requestBody(task, input, temperature) {
    const body = {
      model: modelName(),
      messages: [
        { role: 'system', content: await systemPrompt() },
        { role: 'user', content: JSON.stringify(input) },
      ],
      response_format: { type: 'json_object' },
      temperature,
      max_tokens: task === 'compile' ? 5000 : 900,
    };
    if (usesQwen()) body.enable_thinking = Boolean(enableThinking());
    return body;
  }

  return { requestBody };
}
