import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApp, DifyStoryProvider, parseDifyResult } from '../server.mjs';
import { planTask, supportedTasks } from '../agent/planner.mjs';
import { createValidator } from '../agent/validator.mjs';
import { createStateManager } from '../agent/state-manager.mjs';

let app;
const owner = 'owner_test_123456';

async function rawRequest(path, options = {}) {
  const req = Readable.from(options.body ? [options.body] : []);
  req.method = options.method || 'GET';
  req.url = path;
  req.headers = { 'content-type': 'application/json', 'x-owner-id': owner, ...(options.headers || {}) };
  const response = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
      end(chunk = '') { resolve({ status: this.statusCode, headers: this.headers, body: String(chunk) }); },
    };
    app.handle(req, res);
  });
  const payload = response.headers['content-type']?.includes('application/json') ? JSON.parse(response.body || '{}') : response.body;
  return { status: response.status, payload };
}

async function request(path, options = {}) {
  const { status, payload } = await rawRequest(path, options);
  assert.ok(status >= 200 && status < 300 && payload.ok, `${status}: ${payload.error?.message || 'request failed'}`);
  return payload;
}

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'her-origin-test-'));
  app = await createApp({ STORY_PROVIDER: 'mock', DATABASE_FILE: join(dir, 'test.sqlite'), MAX_NEW_STORIES: '10', MAX_COMPLETED_ROUTES: '4' });
});

after(() => app.close());

test('health explicitly reports mock as development-only', async () => {
  const health = await request('/api/health', { headers: {} });
  assert.equal(health.ready, true);
  assert.equal(health.generationAvailable, false);
  assert.equal(health.inviteRequired, false);
});

test('invite gate keeps the page public and protects story APIs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'her-origin-invite-'));
  const inviteApp = await createApp({ STORY_PROVIDER: 'mock', INVITE_CODE: 'moonlit-2026', DATABASE_FILE: join(dir, 'test.sqlite') });
  const oldApp = app;
  app = inviteApp;
  try {
    const page = await rawRequest('/', { headers: {} });
    assert.equal(page.status, 200);
    assert.match(page.payload, /access-gate/);

    const health = await rawRequest('/api/health', { headers: {} });
    assert.equal(health.status, 200);
    assert.equal(health.payload.inviteRequired, true);
    assert.equal(Object.hasOwn(health.payload, 'provider'), false);
    assert.equal(Object.hasOwn(health.payload, 'model'), false);

    const blocked = await rawRequest('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '林夏' }, category: 'family' }) });
    assert.equal(blocked.status, 401);
    assert.equal(blocked.payload.error.code, 'INVITE_REQUIRED');
    assert.doesNotMatch(blocked.payload.error.message, /Dify|API|密钥|工作流/i);

    const wrong = await rawRequest('/api/access', { method: 'POST', body: JSON.stringify({ inviteCode: 'wrong-code' }), headers: {} });
    assert.equal(wrong.status, 401);
    const accepted = await rawRequest('/api/access', { method: 'POST', body: JSON.stringify({ inviteCode: 'moonlit-2026' }), headers: {} });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.payload.accepted, true);

    const session = await rawRequest('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '林夏' }, category: 'family' }), headers: { 'x-invite-code': 'moonlit-2026' } });
    assert.equal(session.status, 201);
  } finally {
    app = oldApp;
    inviteApp.close();
  }
});

test('full family route persists custom scenario, custom actions, compilation and cache', async () => {
  const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '林夏', lifeStage: '成年大学生', traits: ['认真'] }, category: 'family' }) });
  const storyId = session.story.id;
  const proposals = await request(`/api/stories/${storyId}/proposals`, { method: 'POST', body: JSON.stringify({ batchKey: 'batch-one', excludedProposalSummaries: [] }) });
  assert.equal(proposals.story.proposals.filter((item) => item.batchKey === 'batch-one').length, 3);
  const open = await request(`/api/stories/${storyId}/open`, { method: 'POST', body: JSON.stringify({ customScenario: '她拿到外地工作的机会，但家里希望她留下照顾家中事务。', expectation: '她能和家人谈清楚责任安排并保留自己的选择。' }) });
  assert.equal(open.node.stage, 'opening');
  const first = await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 1, actionText: '她先整理照护安排和自己的工作计划，再约家人坐下来逐项沟通。' }) });
  assert.match(first.node.text, /她先整理照护安排和自己的工作计划/);
  const second = await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, actionText: '她提出先试行一个月的分工，并把复盘时间写进家庭日程。', action1: first.node.incomingAction }) });
  assert.equal(second.route.action2, '她提出先试行一个月的分工，并把复盘时间写进家庭日程。');
  const compiled = await request(`/api/stories/${storyId}/compilation`, { method: 'POST', body: JSON.stringify({ routeId: second.route.id }) });
  assert.ok(compiled.route.compilation.text.length >= 1000 && compiled.route.compilation.text.length <= 3000);
  const repeat = await request(`/api/stories/${storyId}/compilation`, { method: 'POST', body: JSON.stringify({ routeId: second.route.id }) });
  assert.equal(repeat.usage.inputTokens, 0);
  const saved = await request(`/api/stories/${storyId}`);
  assert.equal(saved.story.routes.length, 1);
  assert.equal(saved.story.nodes.filter((node) => node.stage === 'ending').length, 1);
});

test('campus story supports both binary decisions and keeps old routes', async () => {
  const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '周宁', lifeStage: '成年大学生', traits: ['慢热', '细致'] }, category: 'campus' }) });
  const storyId = session.story.id;
  await request(`/api/stories/${storyId}/open`, { method: 'POST', body: JSON.stringify({ customScenario: '她想把一组观察校园生活的照片投给校内展览，但担心作品还不够成熟。' }) });
  const firstA = await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 1, choiceKey: 'A' }) });
  await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, choiceKey: 'A', action1: firstA.node.incomingAction }) });
  await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, choiceKey: 'B', action1: firstA.node.incomingAction }) });
  const firstB = await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 1, choiceKey: 'B' }) });
  await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, choiceKey: 'A', action1: firstB.node.incomingAction }) });
  await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, choiceKey: 'B', action1: firstB.node.incomingAction }) });
  const saved = await request(`/api/stories/${storyId}`);
  assert.equal(saved.story.routes.length, 4);
  assert.equal(saved.story.nodes.filter((node) => node.stage === 'middle').length, 2);
  assert.equal(saved.story.nodes.filter((node) => node.stage === 'ending').length, 4);
});

test('urban category creates a story and reaches scenario proposals', async () => {
  const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '程安', lifeStage: '成年初入社会', traits: ['独立'] }, category: 'urban' }) });
  assert.equal(session.story.category, 'urban');
  const proposals = await request(`/api/stories/${session.story.id}/proposals`, { method: 'POST', body: JSON.stringify({ batchKey: 'urban-one', excludedProposalSummaries: [] }) });
  assert.equal(proposals.story.proposals.filter((item) => item.batchKey === 'urban-one').length, 3);
  assert.match(proposals.story.proposals.at(-1).title, /都市/);
});

test('limits block a fifth completed route without deleting old routes', async () => {
  const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '许愿', lifeStage: '成年大学生', traits: [] }, category: 'family' }) });
  const storyId = session.story.id;
  await request(`/api/stories/${storyId}/open`, { method: 'POST', body: JSON.stringify({ customScenario: '她想搬出去独立生活，但家人担心费用和照护安排。' }) });
  const firstA = await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 1, choiceKey: 'A' }) });
  const firstB = await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 1, choiceKey: 'B' }) });
  for (const first of [firstA, firstB]) {
    await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, choiceKey: 'A', action1: first.node.incomingAction }) });
    await request(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, choiceKey: 'B', action1: first.node.incomingAction }) });
  }
  const overflow = await rawRequest(`/api/stories/${storyId}/actions`, { method: 'POST', body: JSON.stringify({ stage: 2, action1: firstA.node.incomingAction, actionText: '她把第三套行动方案写成邮件，再请求家人逐条回复。' }) });
  assert.equal(overflow.status, 429);
  assert.equal(overflow.payload.error.code, 'ROUTE_LIMIT');
  const saved = await request(`/api/stories/${storyId}`);
  assert.equal(saved.story.routes.length, 4);
});

test('api mode fails loudly when no server key exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'her-origin-api-missing-'));
  const apiApp = await createApp({ STORY_PROVIDER: 'api', MODEL_API_KEY: '', QWEN_API_KEY: '', DEEPSEEK_API_KEY: '', DATABASE_FILE: join(dir, 'test.sqlite') });
  const oldApp = app;
  app = apiApp;
  try {
    const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '陈希', lifeStage: '成年大学生', traits: [] }, category: 'campus' }) });
    const result = await rawRequest(`/api/stories/${session.story.id}/proposals`, { method: 'POST', body: JSON.stringify({ batchKey: 'api-missing', excludedProposalSummaries: [] }) });
    assert.equal(result.status, 503);
    assert.equal(result.payload.error.code, 'API_NOT_CONFIGURED');
  } finally {
    app = oldApp;
    apiApp.close();
  }
});

test('planner covers the five story tasks', () => {
  assert.deepEqual(supportedTasks(), ['propose', 'open', 'advance', 'end', 'compile']);
  assert.equal(planTask('propose').action, 'OFFER_SCENARIOS');
  assert.equal(planTask('open').next, 'advance');
  assert.equal(planTask('compile').next, 'done');
});

test('validator rejects malformed story output', () => {
  const validator = createValidator({ countVisible: (value) => [...String(value || '').replace(/\s/g, '')].length, problem: (status, code, message) => Object.assign(new Error(message), { status, code }) });
  assert.throws(() => validator.validateModelResult('propose', { schemaVersion: 1, task: 'propose', status: 'ok', data: { proposals: [] } }), { code: 'MODEL_FORMAT_ERROR' });
});

test('validator keeps concrete choices out of open and advance story text', () => {
  const validator = createValidator({ countVisible: (value) => [...String(value || '').replace(/\s/g, '')].length, problem: (status, code, message) => Object.assign(new Error(message), { status, code }) });
  const choices = [
    { key: 'A', label: '放下手里的果盘，告诉母亲自己需要重新分配家务' },
    { key: 'B', label: '先写出复习和家务安排，晚些时候拿计划与母亲商量' },
  ];
  const result = (task, text) => ({
    schemaVersion: 1,
    task,
    status: 'ok',
    data: {
      ...(task === 'open' ? { title: '饭桌旁的决定' } : {}),
      text,
      fixedFacts: ['林夏正在准备考试。'],
      events: ['母亲再次请她承担额外家务。'],
      choices,
    },
    message: '',
  });
  const cleanText = '母亲把果盘放到桌边，又问她能不能收拾厨房。林夏想起还没有复习完的章节，也看见母亲脸上的疲惫。她握着筷子沉默了一会儿，知道这次不能再含糊过去。窗外传来关门声，她抬起头，准备把真正的想法说清楚。';

  assert.doesNotThrow(() => validator.validateModelResult('open', result('open', cleanText)));
  assert.doesNotThrow(() => validator.validateModelResult('advance', result('advance', cleanText)));
  assert.throws(() => validator.validateModelResult('open', result('open', `${cleanText}\nA. ${choices[0].label}\nB. ${choices[1].label}`)), { code: 'MODEL_FORMAT_ERROR' });
  assert.throws(() => validator.validateModelResult('advance', result('advance', `${cleanText}\n选项A：${choices[0].label}`)), { code: 'MODEL_FORMAT_ERROR' });
  assert.throws(() => validator.validateModelResult('open', result('open', `${cleanText}${choices[0].label}`)), { code: 'MODEL_FORMAT_ERROR' });
});

test('validator accepts compile text from 1000 to 3000 visible characters', () => {
  const validator = createValidator({ countVisible: (value) => [...String(value || '').replace(/\s/g, '')].length, problem: (status, code, message) => Object.assign(new Error(message), { status, code }) });
  const compileResult = (length) => ({ schemaVersion: 1, task: 'compile', status: 'ok', data: { title: '边界测试', text: '字'.repeat(length) } });
  assert.doesNotThrow(() => validator.validateModelResult('compile', compileResult(1000)));
  assert.doesNotThrow(() => validator.validateModelResult('compile', compileResult(3000)));
  assert.throws(() => validator.validateModelResult('compile', compileResult(999)), { code: 'COMPILE_LENGTH_ERROR' });
  assert.throws(() => validator.validateModelResult('compile', compileResult(3001)), { code: 'COMPILE_LENGTH_ERROR' });
});

test('state manager keeps only the selected route context', () => {
  const manager = createStateManager();
  const story = {
    character: { name: '林夏', lifeStage: '成年大学生', traits: [] },
    category: 'campus',
    nodes: [
      { id: 'opening', stage: 'opening', text: '开场', incomingAction: null, fixedFacts: [], events: [], choices: [] },
      { id: 'middle-a', stage: 'middle', text: '路线A中段', incomingAction: 'A', fixedFacts: [], events: [], choices: [] },
      { id: 'middle-b', stage: 'middle', text: '路线B中段', incomingAction: 'B', fixedFacts: [], events: [], choices: [] },
      { id: 'ending-a', stage: 'ending', text: '路线A结局', incomingAction: 'A2', parentId: 'middle-a', fixedFacts: [], events: [], choices: [] },
    ],
  };
  const input = manager.inputFor('advance', story, { routeContext: manager.routeContext(story, 'A') });
  assert.deepEqual(input.routeContext.map((node) => node.text), ['开场', '路线A中段']);
  assert.doesNotMatch(JSON.stringify(input), /路线B/);
  assert.deepEqual(manager.routeContext(story, 'A', 'A2', 'ending-a').map((node) => node.text), ['开场', '路线A中段', '路线A结局']);
});

test('Dify result parser accepts string and object workflow outputs', () => {
  const result = { schemaVersion: 1, task: 'open', status: 'ok', data: {}, message: '' };
  assert.deepEqual(parseDifyResult({ data: { outputs: { result_json: JSON.stringify(result) } } }), result);
  assert.deepEqual(parseDifyResult({ data: { outputs: { result_json: result } } }), result);
  assert.throws(() => parseDifyResult({ data: { outputs: {} } }), { code: 'MODEL_FORMAT_ERROR' });
});

test('Dify compile retries validation failures with repair context', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const validResult = {
    schemaVersion: 1,
    task: 'compile',
    status: 'ok',
    data: { title: '完整故事', text: '字'.repeat(1000) },
    message: '',
  };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.inputs.story_input_json);
    requests.push(input);
    const result = requests.length < 3
      ? { ...validResult, data: { ...validResult.data, text: '字'.repeat(735) } }
      : validResult;
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { status: 'succeeded', outputs: { result_json: JSON.stringify(result) }, metadata: { model: 'test-dify' } } };
      },
    };
  };
  try {
    const provider = new DifyStoryProvider({
      DIFY_API_KEY: 'test-key',
      DIFY_BASE_URL: 'https://example.test/v1',
      DIFY_RESPONSE_FIELD: 'result_json',
      DIFY_TIMEOUT_MS: '1000',
      DIFY_COMPILE_REPAIR_ATTEMPTS: '5',
    });
    const result = await provider.generate('compile', {
      task: 'compile',
      character: { name: '林夏' },
      category: 'family',
      scenario: { title: '工作选择' },
      routeContext: [{ stage: 'opening', text: '开场' }],
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[1].validationErrors.length, 1);
    assert.match(requests[1].validationErrors[0], /735/);
    assert.equal(requests[1].invalidOutput.data.text.length, 735);
    assert.equal(result.response.data.text.length, 1000);
    assert.equal(result.usage.prompt_tokens, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dify mode fails clearly when app key is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'her-origin-dify-missing-'));
  const difyApp = await createApp({ STORY_PROVIDER: 'dify', DIFY_API_KEY: '', DATABASE_FILE: join(dir, 'test.sqlite') });
  const oldApp = app;
  app = difyApp;
  try {
    const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ character: { name: '陈希', lifeStage: '成年大学生', traits: [] }, category: 'campus' }) });
    const result = await rawRequest(`/api/stories/${session.story.id}/proposals`, { method: 'POST', body: JSON.stringify({ batchKey: 'dify-missing', excludedProposalSummaries: [] }) });
    assert.equal(result.status, 503);
    assert.equal(result.payload.error.code, 'API_NOT_CONFIGURED');
    assert.equal(result.payload.error.message, '她还没有回应，请稍后再来。');
    assert.doesNotMatch(result.payload.error.message, /Dify|API|密钥|工作流/i);
  } finally {
    app = oldApp;
    difyApp.close();
  }
});
