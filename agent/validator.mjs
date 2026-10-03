export function createValidator({ countVisible, problem }) {
  const optionMarkerPattern = /(?:^|[\r\n。！？；;])\s*(?:选项\s*)?[ABＡＢ]\s*(?:[.．、:：)]|选项)/m;

  function assertString(value, label, min = 1, max = 10000) {
    if (typeof value !== 'string' || countVisible(value) < min || countVisible(value) > max) {
      throw problem(502, 'MODEL_FORMAT_ERROR', `${label}格式不符合要求。`);
    }
    return value.trim();
  }

  function compact(value) {
    return String(value || '').replace(/\s/g, '');
  }

  function assertChoicesStayOutsideStory(text, choices) {
    if (optionMarkerPattern.test(text)) {
      throw problem(502, 'MODEL_FORMAT_ERROR', '故事正文不能列出A/B选项，具体行动只能放在choices字段中。');
    }
    const compactText = compact(text);
    if (choices.some((choice) => compactText.includes(compact(choice.label)))) {
      throw problem(502, 'MODEL_FORMAT_ERROR', '故事正文不能重复展示选项内容，具体行动只能放在choices字段中。');
    }
  }

  function validateModelResult(task, response) {
    if (!response || response.schemaVersion !== 1 || response.task !== task || !['ok', 'needs_revision'].includes(response.status)) {
      throw problem(502, 'MODEL_FORMAT_ERROR', '模型返回格式不符合约定。');
    }
    if (response.status === 'needs_revision') {
      if (!response.message) throw problem(502, 'MODEL_FORMAT_ERROR', '模型的调整提示为空。');
      return response;
    }
    const data = response.data;
    if (!data || typeof data !== 'object') throw problem(502, 'MODEL_FORMAT_ERROR', '模型没有返回有效内容。');
    if (task === 'propose') {
      if (!Array.isArray(data.proposals) || data.proposals.length !== 3) throw problem(502, 'MODEL_FORMAT_ERROR', '情境提案数量不是3个。');
      data.proposals.forEach((item) => {
        assertString(item.title, '提案标题', 2, 40);
        assertString(item.premise, '提案简介', 10, 160);
        assertString(item.positiveDirection, '改善方向', 4, 80);
      });
    } else if (task === 'open' || task === 'advance') {
      assertString(data.text, '故事正文', 80, 1000);
      if (!Array.isArray(data.choices) || data.choices.length !== 2) throw problem(502, 'MODEL_FORMAT_ERROR', '选择节点必须有两个选项。');
      data.choices.forEach((choice, index) => {
        if (choice.key !== ['A', 'B'][index]) throw problem(502, 'MODEL_FORMAT_ERROR', '选择键必须是A和B。');
        assertString(choice.label, '选项', 5, 100);
      });
      if (compact(data.choices[0].label) === compact(data.choices[1].label)) throw problem(502, 'MODEL_FORMAT_ERROR', '两个选项必须是不同的具体行动。');
      assertChoicesStayOutsideStory(data.text, data.choices);
      if (!Array.isArray(data.fixedFacts) || !Array.isArray(data.events)) throw problem(502, 'MODEL_FORMAT_ERROR', '故事事实字段缺失。');
      if (task === 'open') assertString(data.title, '故事标题', 2, 80);
    } else if (task === 'end') {
      assertString(data.text, '结局正文', 80, 1000);
      assertString(data.positiveOutcome, '积极结果', 5, 160);
      if (!Array.isArray(data.fixedFacts) || !Array.isArray(data.events)) throw problem(502, 'MODEL_FORMAT_ERROR', '结局事实字段缺失。');
    } else if (task === 'compile') {
      assertString(data.title, '成稿标题', 2, 80);
      if (typeof data.text !== 'string') throw problem(502, 'MODEL_FORMAT_ERROR', '完整短篇格式不符合要求：data.text 必须是正文字符串。');
      const length = countVisible(data.text);
      if (length < 1000 || length > 3000) throw problem(502, 'COMPILE_LENGTH_ERROR', `完整短篇字数为${length}，需要控制在1000–3000字。`);
    }
    return response;
  }

  return { assertString, validateModelResult };
}
