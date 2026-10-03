import { createServer as createHttpServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { planTask } from './agent/planner.mjs';
import { createGenerator } from './agent/generator.mjs';
import { createValidator } from './agent/validator.mjs';
import { createStateManager } from './agent/state-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC_DIR = join(ROOT, 'public');
const BUNDLED_PROMPT_FILE = join(ROOT, 'prompts', 'system-prompt.txt');
const PROMPT_FILE = existsSync(resolve(ROOT, '..', '开发交接', '02-故事生成系统提示词.txt'))
  ? resolve(ROOT, '..', '开发交接', '02-故事生成系统提示词.txt')
  : BUNDLED_PROMPT_FILE;
const PROMPT_VERSION = 'her-origin-story-v1.4';

const DEFAULTS = {
  PORT: '5174', HOST: '0.0.0.0', STORY_PROVIDER: 'api',
  MODEL_PROVIDER: 'qwen', MODEL_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', MODEL_ID: 'qwen3.7-flash', MODEL_API_KEY: '', ENABLE_THINKING: 'false',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_THINKING: 'disabled',
  DIFY_BASE_URL: 'https://api.dify.ai/v1', DIFY_API_KEY: '', DIFY_RESPONSE_FIELD: 'result_json', DIFY_TIMEOUT_MS: '90000', DIFY_COMPILE_REPAIR_ATTEMPTS: '5',
  DATABASE_FILE: join(ROOT, 'data', 'her-origin.sqlite'), INVITE_CODE: '',
  MAX_NEW_STORIES: '5', MAX_COMPLETED_ROUTES: '4', MAX_DAILY_PROPOSALS: '10',
  MAX_DAILY_REQUESTS: '50', GLOBAL_CONCURRENCY: '2', OWNER_CONCURRENCY: '1',
  DAILY_BUDGET_USD: '0', TOTAL_BUDGET_USD: '0',
  INPUT_PRICE_PER_MILLION_USD: '0', OUTPUT_PRICE_PER_MILLION_USD: '0',
};

function loadEnv(text = '') {
  const env = { ...DEFAULTS };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !match[1].startsWith('#')) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  for (const key of Object.keys(DEFAULTS)) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const key of ['DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'MODEL_API_KEY', 'DIFY_API_KEY']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function int(env, key) { return Number.parseInt(env[key], 10) || 0; }
function num(env, key) { return Number.parseFloat(env[key]) || 0; }
function modelApiKey(env) { return env.MODEL_API_KEY || env.QWEN_API_KEY || env.DEEPSEEK_API_KEY || ''; }
function modelBaseUrl(env) { return (env.MODEL_BASE_URL || env.DEEPSEEK_BASE_URL || '').replace(/\/$/, ''); }
function modelName(env) { return env.MODEL_ID || env.DEEPSEEK_MODEL || 'unknown-model'; }
function usesQwen(env) { return env.MODEL_PROVIDER === 'qwen' || modelName(env).startsWith('qwen'); }
function providerConfigured(env) {
  if (env.STORY_PROVIDER === 'mock') return false;
  if (env.STORY_PROVIDER === 'dify') return Boolean(env.DIFY_API_KEY);
  return Boolean(modelApiKey(env));
}
function providerModel(env) {
  if (env.STORY_PROVIDER === 'mock') return 'mock-development-only';
  if (env.STORY_PROVIDER === 'dify') return 'dify-workflow';
  return modelName(env);
}
function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24); }
function cleanText(value) { return typeof value === 'string' ? value.trim() : ''; }
function countVisible(value) { return [...String(value || '').replace(/\s/g, '')].length; }
function json(value) { return JSON.stringify(value ?? null); }
function parse(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function sameDay(iso, date = new Date()) { return String(iso).slice(0, 10) === date.toISOString().slice(0, 10); }
function safeFilename(value) { return String(value || '故事').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 80) || '故事'; }

function validateCharacter(input) {
  const name = cleanText(input?.name);
  const lifeStage = cleanText(input?.lifeStage) || '成年大学生';
  const traits = Array.isArray(input?.traits) ? input.traits.map(cleanText).filter(Boolean).slice(0, 2) : [];
  if (countVisible(name) < 1 || countVisible(name) > 12) throw problem(400, 'INVALID_CHARACTER', '女主名字需要是1–12个可见字符。');
  if (countVisible(lifeStage) > 40) throw problem(400, 'INVALID_CHARACTER', '人生阶段描述不能超过40个字符。');
  if (traits.some((trait) => countVisible(trait) > 50)) throw problem(400, 'INVALID_CHARACTER', '性格描述不能超过50个字符。');
  return { name, lifeStage, traits };
}

function validateCategory(category) {
  if (!['family', 'campus', 'urban'].includes(category)) throw problem(400, 'INVALID_CATEGORY', '请选择家庭、校园或都市。');
  return category;
}

function categoryLabel(category) {
  return { family: '家庭', campus: '校园', urban: '都市' }[category] || '现实生活';
}

function validateCustom(value, min, max, label) {
  const text = cleanText(value);
  if (text && (countVisible(text) < min || countVisible(text) > max)) throw problem(400, 'INVALID_INPUT', `${label}需要是${min}–${max}个可见字符。`);
  return text;
}

function problem(status, code, message, extra = {}) {
  const error = new Error(message); error.status = status; error.code = code; Object.assign(error, extra); return error;
}

function parseJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = ''; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 1_000_000) reject(problem(413, 'PAYLOAD_TOO_LARGE', '提交内容过大。')); else body += chunk; });
    req.on('end', () => { if (!body) return resolvePromise({}); try { resolvePromise(JSON.parse(body)); } catch { reject(problem(400, 'INVALID_JSON', '请求格式无法读取。')); } });
    req.on('error', reject);
  });
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}
function ok(data = {}) { return { ok: true, ...data }; }
const publicErrorMessages = {
  INVITE_REQUIRED: '这枚体验码还没有让这段路亮起来，请再确认一次。',
  API_NOT_CONFIGURED: '她还没有回应，请稍后再来。',
  API_UNAUTHORIZED: '这段路暂时没有回应，请稍后再试。',
  API_BALANCE: '今天能点亮的岔路已经走到尽头，明天再来。',
  API_RATE_LIMIT: '此刻人声太近了，请过一会儿再来。',
  API_ERROR: '这一页暂时没有回应，请稍后再试。',
  API_REPAIR_FAILED: '这一页还没有整理好，请稍后再试。',
  API_TIMEOUT: '她走得有些慢，请稍后再试。',
  API_NETWORK_ERROR: '这一页暂时没有回应，请稍后再试。',
  MODEL_FORMAT_ERROR: '这一页还没有整理好，请稍后再试。',
  COMPILE_LENGTH_ERROR: '这一页还没有整理妥当。过一会儿再翻开看看，她会继续把余下的路写完。',
};
function publicError(error) {
  const code = error.code || 'SERVER_ERROR';
  return { ok: false, error: { code, message: publicErrorMessages[code] || error.message || '服务暂时不可用。' } };
}

function initDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, character_json TEXT NOT NULL,
      category TEXT NOT NULL, scenario_json TEXT, expectation TEXT, status TEXT NOT NULL,
      prompt_version TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL, batch_key TEXT NOT NULL, idx INTEGER NOT NULL,
      data_json TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(story_id, batch_key, idx)
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL, parent_id TEXT, stage TEXT NOT NULL,
      text TEXT NOT NULL, incoming_action TEXT, choices_json TEXT, fixed_facts_json TEXT,
      events_json TEXT, data_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL, action1 TEXT NOT NULL, action2 TEXT NOT NULL,
      ending_node_id TEXT NOT NULL, positive_outcome TEXT, compilation_title TEXT,
      compilation_text TEXT, compilation_version TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(story_id, action1, action2)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, story_id TEXT, task TEXT NOT NULL,
      request_key TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_json TEXT,
      model TEXT, prompt_version TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cost_usd REAL DEFAULT 0, duration_ms INTEGER, created_at TEXT NOT NULL, completed_at TEXT,
      UNIQUE(owner_id, task, request_key)
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, route_id TEXT NOT NULL, rating INTEGER,
      reasons_json TEXT, comment TEXT, consent_version TEXT, created_at TEXT NOT NULL
    );
  `);
  return db;
}

function readStory(db, storyId, ownerId) {
  const row = db.prepare('SELECT * FROM stories WHERE id = ? AND owner_id = ?').get(storyId, ownerId);
  if (!row) throw problem(404, 'STORY_NOT_FOUND', '找不到这个故事，或它不属于当前浏览器。');
  const story = {
    id: row.id, ownerId: row.owner_id, character: parse(row.character_json), category: row.category,
    scenario: parse(row.scenario_json), expectation: row.expectation || '', status: row.status,
    promptVersion: row.prompt_version, schemaVersion: row.schema_version, createdAt: row.created_at, updatedAt: row.updated_at,
    proposals: [], nodes: [], routes: [],
  };
  story.proposals = db.prepare('SELECT * FROM proposals WHERE story_id = ? ORDER BY created_at, idx').all(storyId).map((item) => ({ id: item.id, batchKey: item.batch_key, ...parse(item.data_json), source: item.source }));
  story.nodes = db.prepare('SELECT * FROM nodes WHERE story_id = ? ORDER BY created_at').all(storyId).map((item) => ({
    id: item.id, parentId: item.parent_id, stage: item.stage, text: item.text, incomingAction: parse(item.incoming_action),
    choices: parse(item.choices_json, []), fixedFacts: parse(item.fixed_facts_json, []), events: parse(item.events_json, []),
  }));
  story.routes = db.prepare('SELECT * FROM routes WHERE story_id = ? ORDER BY created_at').all(storyId).map((item) => ({
    id: item.id, action1: item.action1, action2: item.action2, endingNodeId: item.ending_node_id,
    positiveOutcome: item.positive_outcome, compilation: item.compilation_text ? { title: item.compilation_title, text: item.compilation_text, version: item.compilation_version } : null,
    status: item.status, createdAt: item.created_at,
  }));
  return story;
}

function ownerIdFrom(req) {
  const value = cleanText(req.headers['x-owner-id']);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw problem(400, 'INVALID_OWNER', '浏览器身份标识无效，请刷新页面重试。');
  return value;
}

function checkInvite(req, env) {
  if (!env.INVITE_CODE) return;
  const provided = cleanText(req.headers['x-invite-code']);
  const expected = cleanText(env.INVITE_CODE);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  const accepted = providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  if (!accepted) throw problem(401, 'INVITE_REQUIRED', '这枚体验码还没有让这段路亮起来，请再确认一次。');
}

function createLimiter(env) {
  const activeOwners = new Map(); let active = 0;
  return {
    async run(ownerId, fn) {
      const ownerLimit = int(env, 'OWNER_CONCURRENCY'); const globalLimit = int(env, 'GLOBAL_CONCURRENCY');
      if (ownerLimit && (activeOwners.get(ownerId) || 0) >= ownerLimit) throw problem(429, 'OWNER_BUSY', '当前已有生成任务，请等待它完成。');
      if (globalLimit && active >= globalLimit) throw problem(429, 'GLOBAL_BUSY', '当前生成任务较多，请稍后再试。');
      active += 1; activeOwners.set(ownerId, (activeOwners.get(ownerId) || 0) + 1);
      try { return await fn(); } finally { active -= 1; const next = (activeOwners.get(ownerId) || 1) - 1; if (next) activeOwners.set(ownerId, next); else activeOwners.delete(ownerId); }
    },
  };
}

function todayRequestCount(db, ownerId) {
  return db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE owner_id = ? AND created_at >= ?').get(ownerId, `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).count;
}
function todayProposalCount(db, ownerId) {
  return db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE owner_id = ? AND task = ? AND created_at >= ?').get(ownerId, 'propose', `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).count;
}
function storyCount(db, ownerId) { return db.prepare('SELECT COUNT(*) AS count FROM stories WHERE owner_id = ?').get(ownerId).count; }
function completedRouteCount(db, storyId) { return db.prepare('SELECT COUNT(*) AS count FROM routes WHERE story_id = ?').get(storyId).count; }
function totalSpend(db) { return db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS value FROM jobs WHERE status = ?').get('succeeded').value; }
function dailySpend(db) { return db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS value FROM jobs WHERE status = ? AND created_at >= ?').get('succeeded', `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).value; }

const validator = createValidator({ countVisible, problem });
const { validateModelResult } = validator;
const stateManager = createStateManager();
const { inputFor: taskInputFor, contextNode: routeContextNode } = stateManager;

function mockText(label, scenario, action1 = '', action2 = '') {
  return `${label}：${scenario?.title || scenario?.text || '这段经历'}。${action1 ? `她选择${action1}，` : ''}${action2 ? `后来又${action2}，` : ''}她没有等一个突然出现的答案，而是把眼前的事情拆成可以完成的一步。她先确认自己真正想争取的部分，再和身边的人说明具体安排，留下可以继续讨论的空间。事情没有立刻变得完美，但原本模糊的压力开始有了边界，新的信息也让她看见了下一步。她的行动被认真对待，现实里出现了可以观察的变化：一项安排被重新确认，一份作品获得了展示机会，或一段关系建立起更平等的沟通方式。她仍然保留自己的判断，也愿意在需要时寻求支持。`;
}
function mockCompile(story, action1, action2, outcome) {
  const seed = `${story.character.name}在${categoryLabel(story.category)}中遇到${story.scenario?.title || story.scenario?.text || '一件需要面对的事'}。${story.scenario?.premise || ''}她原本想要的是${story.scenario?.positiveDirection || '为自己争取一个清楚而可行的安排'}。事情逼近时，她没有把沉默当成唯一的选择，而是先看清自己真正能做什么。第一次，她${action1}。这个行动没有让所有问题立刻消失，却让她得到了一些具体回应，也让冲突从情绪变成了可以继续讨论的事实。接下来，她面对新的变化。第二次，她${action2}。这一次她更清楚自己的边界和优先顺序，既没有把决定交给别人，也没有用伤害谁的方式证明自己。经过沟通、准备和一次次小的确认，她终于把想法落实成了现实中的安排。${outcome || '她获得了具体的支持、机会或更平等的关系'}。回头看，她并不是突然变得无所畏惧，只是在关键处愿意为自己多做一步。她学会把愿望说清楚，把困难拆开，把可以争取的部分留在手里。这个结果不依赖所有人都按照她的期待改变，重要的是她的选择被看见，她也拥有了继续往前走的空间。`;
  return seed.repeat(Math.ceil(2300 / countVisible(seed))).slice(0, 2500);
}
function mockResult(task, input) {
  const defaultTitles = { family: '想把自己的决定说清楚', campus: '想让自己的作品被看见', urban: '想在城市里站稳自己的位置' };
  const scenario = input.scenario || { title: defaultTitles[input.category] || '想为自己争取一次选择', premise: input.scenario?.text || '她遇到了一件需要通过行动推进的事情。', positiveDirection: '获得具体的空间与支持' };
  const name = input.character.name;
  if (task === 'propose') {
    const prefix = categoryLabel(input.category);
    return { schemaVersion: 1, task, status: 'ok', data: { proposals: [
      { title: `${prefix}里的新安排`, premise: `${name}想争取一项对她很重要的安排，但身边的人有自己的顾虑，双方还没有找到合适的沟通方式。`, positiveDirection: '把需求说清楚并获得可执行空间' },
      { title: `${prefix}中的临时变化`, premise: `一件临时变化打乱了${name}原本的计划，她需要在有限时间里确认优先级，也要让相关的人听见她的想法。`, positiveDirection: '重新分配责任并推进自己的计划' },
      { title: `${prefix}关系的边界`, premise: `${name}在一段重要关系里感到消耗，却又不想简单地切断联系，她需要找到更平等的相处方式。`, positiveDirection: '建立边界并保留可靠的支持' },
    ] }, message: '' };
  }
  if (task === 'open') return { schemaVersion: 1, task, status: 'ok', data: { title: scenario.title || `${name}的一个决定`, text: mockText(`${name}站在事情开始的地方`, scenario), fixedFacts: [`${name}是${input.character.lifeStage}。`, `故事发生在${categoryLabel(input.category)}场景中。`, '她有一个希望被认真对待的具体愿望。'], events: ['冲突已经出现，但还没有被解决。'], choices: [{ key: 'A', label: '先和关键的人把需求与顾虑讲清楚' }, { key: 'B', label: '先独立准备一份可执行的计划再沟通' }] }, message: '' };
  if (task === 'advance') return { schemaVersion: 1, task, status: 'ok', data: { text: mockText(`${name}采取行动后`, scenario, input.selectedAction1), fixedFacts: ['她已经完成了第一次行动，并得到了一项具体回应。'], events: ['原本模糊的冲突出现了可以继续处理的新信息。'], choices: [{ key: 'A', label: '根据新信息调整计划并争取明确承诺' }, { key: 'B', label: '保留自己的底线，同时寻找另一种支持方式' }] }, message: '' };
  if (task === 'end') return { schemaVersion: 1, task, status: 'ok', data: { text: mockText(`${name}迎来转折`, scenario, input.selectedAction1, input.selectedAction2), fixedFacts: ['她的两次行动都已经落实到故事中。'], events: ['她获得了可观察的积极变化。'], positiveOutcome: `${name}获得了更清楚的安排、边界和继续推进的现实空间。` }, message: '' };
  return { schemaVersion: 1, task, status: 'ok', data: { title: `${name}把想法带到现实里`, text: mockCompile({ ...input, scenario }, input.selectedAction1 || '把需求讲清楚', input.selectedAction2 || '根据回应继续推进', input.positiveOutcome) }, message: '' };
}

class StoryProvider {
  constructor(env) { this.env = env; this.prompt = null; }
  async systemPrompt() { if (!this.prompt) this.prompt = await readFile(PROMPT_FILE, 'utf8'); return this.prompt; }
  async generate(task, input) { throw new Error('Not implemented'); }
}

class MockStoryProvider extends StoryProvider {
  async generate(task, input) { await this.systemPrompt(); return { response: mockResult(task, input), usage: { prompt_tokens: 0, completion_tokens: 0 }, model: 'mock-development-only' }; }
}

class ApiStoryProvider extends StoryProvider {
  constructor(env) {
    super(env);
    this.generator = createGenerator({
      modelName: () => modelName(this.env),
      usesQwen: () => usesQwen(this.env),
      systemPrompt: () => this.systemPrompt(),
      enableThinking: () => String(this.env.ENABLE_THINKING).toLowerCase() === 'true',
    });
  }

  async generate(task, input) {
    planTask(task, input);
    const apiKey = modelApiKey(this.env);
    if (!apiKey) throw problem(503, 'API_NOT_CONFIGURED', `服务端还没有配置 ${this.env.MODEL_PROVIDER || '模型'} API Key；真实 API 试用尚未完成。`);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`${modelBaseUrl(this.env)}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(await this.generator.requestBody(task, input, 0.8)),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) throw problem(502, 'API_UNAUTHORIZED', '模型 API Key 无效或未授权。');
        if (response.status === 402) throw problem(502, 'API_BALANCE', '模型账户余额不足，真实生成未完成。');
        if (response.status === 429) throw problem(429, 'API_RATE_LIMIT', '模型服务正在限流，请稍后重试。');
        throw problem(502, 'API_ERROR', payload?.error?.message || '模型服务返回错误。');
      }
      const content = payload?.choices?.[0]?.message?.content;
      let parsed = parse(content);
      if (!parsed) {
        const repair = await this.repair(task, input, content, '模型输出不是有效JSON。'); parsed = repair.response;
        return { response: parsed, usage: repair.usage || payload.usage || {}, model: payload.model || modelName(this.env) };
      }
      try { validateModelResult(task, parsed); } catch (error) {
        const repair = await this.repair(task, input, parsed, error.message); parsed = repair.response;
        return { response: parsed, usage: repair.usage || payload.usage || {}, model: payload.model || modelName(this.env) };
      }
      return { response: parsed, usage: payload.usage || {}, model: payload.model || modelName(this.env) };
    } catch (error) {
      if (error.name === 'AbortError') throw problem(504, 'API_TIMEOUT', '模型生成超时，请在额度允许时重试。');
      if (error.name === 'TypeError' && error.message === 'fetch failed') throw problem(502, 'API_NETWORK_ERROR', '无法连接模型服务，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async repair(task, input, invalidOutput, validationError) {
    const apiKey = modelApiKey(this.env);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`${modelBaseUrl(this.env)}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(await this.generator.requestBody(task, { ...input, validationErrors: [validationError], invalidOutput }, 0.4)),
      });
      const payload = await response.json().catch(() => ({})); if (!response.ok) throw problem(502, 'API_REPAIR_FAILED', '模型输出修复失败，请稍后重试。');
      const parsed = parse(payload?.choices?.[0]?.message?.content); validateModelResult(task, parsed); return { response: parsed, usage: payload.usage || {} };
    } catch (error) {
      if (error.name === 'AbortError') throw problem(504, 'API_TIMEOUT', '模型修复超时，请稍后重试。');
      if (error.name === 'TypeError' && error.message === 'fetch failed') throw problem(502, 'API_NETWORK_ERROR', '无法连接模型服务，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
}

export function parseDifyResult(payload, responseField = 'result_json') {
  const value = payload?.data?.outputs?.[responseField];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed = parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  throw problem(502, 'MODEL_FORMAT_ERROR', `工作流没有返回有效的 ${responseField}。`);
}

function difyUsage(payload) {
  const data = payload?.data || {};
  const metadata = data.metadata || {};
  const usage = metadata.usage || data.usage || {};
  return {
    prompt_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? metadata.total_tokens ?? data.total_tokens) || 0,
    completion_tokens: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
  };
}

export class DifyStoryProvider extends StoryProvider {
  async runWorkflow(plan, input, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${String(this.env.DIFY_BASE_URL || '').replace(/\/$/, '')}/workflows/run`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.env.DIFY_API_KEY}`,
        },
        body: JSON.stringify({
          inputs: {
            task: plan.task,
            story_input_json: JSON.stringify(input),
          },
          response_mode: 'blocking',
          user: `story-${hash({ character: input.character, category: input.category })}`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload?.message || payload?.error?.message || '';
        if ([401, 403].includes(response.status)) throw problem(502, 'API_UNAUTHORIZED', 'Dify 应用密钥无效、未授权或工作流尚未发布。');
        if (response.status === 402) throw problem(502, 'API_BALANCE', 'Dify 或模型账户额度不足，本次生成未完成。');
        if (response.status === 429) throw problem(429, 'API_RATE_LIMIT', '工作流正在限流，请稍后重试。');
        throw problem(502, 'API_ERROR', detail || 'Dify 工作流返回错误。');
      }
      if (payload?.data?.status && payload.data.status !== 'succeeded') {
        throw problem(502, 'API_ERROR', payload.data.error || 'Dify 工作流没有成功完成。');
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw problem(504, 'API_TIMEOUT', '故事工作流运行超时，请稍后重试。');
      if (error.name === 'TypeError' && error.message === 'fetch failed') throw problem(502, 'API_NETWORK_ERROR', '无法连接故事工作流，请检查网络后重试。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(task, input) {
    const plan = planTask(task, input);
    if (!this.env.DIFY_API_KEY) throw problem(503, 'API_NOT_CONFIGURED', '服务端还没有配置 Dify 应用密钥；工作流尚未连接。');
    const timeout = Math.max(1_000, int(this.env, 'DIFY_TIMEOUT_MS') || 90_000);
    const maxRepairAttempts = task === 'compile'
      ? Math.max(0, int(this.env, 'DIFY_COMPILE_REPAIR_ATTEMPTS') || 5)
      : 0;
    let requestInput = input;
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
    let lastModel = 'dify-workflow';

    for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
      const payload = await this.runWorkflow(plan, requestInput, timeout);
      const usage = difyUsage(payload);
      totalUsage = {
        prompt_tokens: totalUsage.prompt_tokens + usage.prompt_tokens,
        completion_tokens: totalUsage.completion_tokens + usage.completion_tokens,
      };
      lastModel = payload?.data?.metadata?.model || lastModel;

      let parsed = null;
      try {
        parsed = parseDifyResult(payload, this.env.DIFY_RESPONSE_FIELD || 'result_json');
        validateModelResult(task, parsed);
        return { response: parsed, usage: totalUsage, model: lastModel };
      } catch (error) {
        if (task !== 'compile' || attempt >= maxRepairAttempts) throw error;
        const output = payload?.data?.outputs?.[this.env.DIFY_RESPONSE_FIELD || 'result_json'] ?? null;
        requestInput = {
          ...input,
          validationErrors: [error.message],
          invalidOutput: parsed || output,
        };
      }
    }

    throw problem(502, 'COMPILE_LENGTH_ERROR', '完整短篇暂时没有整理好，请稍后再试。');
  }
}

function createStoryProvider(env) {
  if (env.STORY_PROVIDER === 'mock') return new MockStoryProvider(env);
  if (env.STORY_PROVIDER === 'api') return new ApiStoryProvider(env);
  if (env.STORY_PROVIDER === 'dify') return new DifyStoryProvider(env);
  throw problem(500, 'INVALID_PROVIDER', `不支持的 STORY_PROVIDER：${env.STORY_PROVIDER}`);
}

function calculateCost(env, usage) {
  return Number((((Number(usage.prompt_tokens) || 0) / 1_000_000) * num(env, 'INPUT_PRICE_PER_MILLION_USD') + ((Number(usage.completion_tokens) || 0) / 1_000_000) * num(env, 'OUTPUT_PRICE_PER_MILLION_USD')).toFixed(8));
}

export function createApp(overrides = {}) {
  const envFile = join(ROOT, '.env');
  const env = { ...loadEnv(existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''), ...overrides };
  const dbFile = resolve(env.DATABASE_FILE || DEFAULTS.DATABASE_FILE);
  if (!existsSync(dirname(dbFile))) return mkdir(dirname(dbFile), { recursive: true }).then(() => createApp(overrides));
  const db = initDb(dbFile); const limiter = createLimiter(env); const provider = createStoryProvider(env);

  async function execute(ownerId, storyId, task, requestInput, work) {
    if (todayRequestCount(db, ownerId) >= int(env, 'MAX_DAILY_REQUESTS')) throw problem(429, 'DAILY_REQUEST_LIMIT', '今日模型请求额度已用完，请明天再试。');
    if (num(env, 'DAILY_BUDGET_USD') > 0 && dailySpend(db) >= num(env, 'DAILY_BUDGET_USD')) throw problem(429, 'DAILY_BUDGET_LIMIT', '今日测试预算已用完。');
    if (num(env, 'TOTAL_BUDGET_USD') > 0 && totalSpend(db) >= num(env, 'TOTAL_BUDGET_USD')) throw problem(429, 'TOTAL_BUDGET_LIMIT', '本次测试总预算已用完。');
    const requestKey = hash(requestInput); const existing = db.prepare('SELECT * FROM jobs WHERE owner_id = ? AND task = ? AND request_key = ?').get(ownerId, task, requestKey);
    if (existing?.status === 'succeeded') return { job: existing, result: parse(existing.result_json) };
    if (existing?.status === 'running') throw problem(409, 'JOB_RUNNING', '相同的生成任务正在处理中，请稍候。');
    const jobId = existing?.id || id('job'); const createdAt = existing?.created_at || now();
    if (existing) db.prepare('UPDATE jobs SET status = ?, error_json = NULL WHERE id = ?').run('running', jobId);
    else db.prepare('INSERT INTO jobs (id, owner_id, story_id, task, request_key, status, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(jobId, ownerId, storyId, task, requestKey, 'running', providerModel(env), PROMPT_VERSION, createdAt);
    const started = Date.now();
    try {
      const generated = await limiter.run(ownerId, work); const response = validateModelResult(task, generated.response); const usage = generated.usage || {}; const cost = calculateCost(env, usage);
      db.prepare('UPDATE jobs SET status = ?, result_json = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, duration_ms = ?, completed_at = ? WHERE id = ?').run('succeeded', json(response), generated.model || '', Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0, cost, Date.now() - started, now(), jobId);
      return { job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId), result: response };
    } catch (error) {
      db.prepare('UPDATE jobs SET status = ?, error_json = ?, duration_ms = ?, completed_at = ? WHERE id = ?').run('failed', json({ code: error.code || 'SERVER_ERROR', message: error.message }), Date.now() - started, now(), jobId);
      throw error;
    }
  }

  function responseWithUsage(story, job, extra = {}) { return ok({ story, ...extra, usage: { inputTokens: job?.input_tokens || 0, outputTokens: job?.output_tokens || 0 } }); }
  function saveNode(storyId, stage, result, parentId, incomingAction) {
    const data = result.data; const nodeId = id('node'); db.prepare('INSERT INTO nodes (id, story_id, parent_id, stage, text, incoming_action, choices_json, fixed_facts_json, events_json, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(nodeId, storyId, parentId, stage, data.text, incomingAction ? json(incomingAction) : null, json(data.choices || []), json(data.fixedFacts || []), json(data.events || []), json(data), now()); return nodeId;
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${env.HOST}:${env.PORT}`); const method = req.method;
      if (method === 'GET' && url.pathname === '/api/health') return send(res, 200, ok({ ready: true, generationAvailable: providerConfigured(env), inviteRequired: Boolean(env.INVITE_CODE) }));
      if (method === 'POST' && url.pathname === '/api/access') {
        const body = await parseJsonBody(req);
        if (env.INVITE_CODE) {
          req.headers['x-invite-code'] = cleanText(body.inviteCode);
          checkInvite(req, env);
        }
        return send(res, 200, ok({ accepted: true, generationAvailable: providerConfigured(env) }));
      }
      if (method === 'GET' && url.pathname === '/') return serveStatic(res, 'index.html');
      if (method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname.slice(1));
      if (!url.pathname.startsWith('/api/')) throw problem(404, 'NOT_FOUND', '页面不存在。');
      checkInvite(req, env);
      const ownerId = ownerIdFrom(req); const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await parseJsonBody(req) : {};

      if (method === 'POST' && url.pathname === '/api/session') {
        const character = validateCharacter(body.character); const category = validateCategory(body.category); const expectation = validateCustom(body.expectation, 1, 100, '期待');
        if (storyCount(db, ownerId) >= int(env, 'MAX_NEW_STORIES')) throw problem(429, 'STORY_LIMIT', '当前邀请码的新故事额度已用完。');
        const storyId = id('story'); const time = now(); db.prepare('INSERT INTO stories (id, owner_id, character_json, category, expectation, status, prompt_version, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(storyId, ownerId, json(character), category, expectation, 'draft', PROMPT_VERSION, 1, time, time); return send(res, 201, responseWithUsage(readStory(db, storyId, ownerId), null));
      }
      const match = url.pathname.match(/^\/api\/stories\/([^/]+)(?:\/(proposals|open|actions|compilation))?$/);
      if (match) {
        const storyId = match[1]; const action = match[2]; const story = readStory(db, storyId, ownerId);
        if (method === 'GET' && !action) return send(res, 200, responseWithUsage(story, null));
        if (method === 'DELETE' && !action) { db.prepare('DELETE FROM stories WHERE id = ? AND owner_id = ?').run(storyId, ownerId); return send(res, 200, ok({ deleted: true })); }
        if (method === 'POST' && action === 'proposals') {
          if (todayProposalCount(db, ownerId) >= int(env, 'MAX_DAILY_PROPOSALS')) throw problem(429, 'PROPOSAL_LIMIT', '今日换情境额度已用完。');
          const batchKey = cleanText(body.batchKey) || id('batch'); const excluded = Array.isArray(body.excludedProposalSummaries) ? body.excludedProposalSummaries.slice(0, 30) : [];
          const existing = db.prepare('SELECT * FROM proposals WHERE story_id = ? AND batch_key = ? ORDER BY idx').all(storyId, batchKey);
          if (existing.length === 3) return send(res, 200, responseWithUsage(readStory(db, storyId, ownerId), null, { batchKey }));
          const taskInput = taskInputFor('propose', story, { excludedProposalSummaries: excluded, constraints: { proposalCount: 3 } }); const outcome = await execute(ownerId, storyId, 'propose', taskInput, () => provider.generate('propose', taskInput));
          outcome.result.data.proposals.forEach((proposal, index) => db.prepare('INSERT INTO proposals (id, story_id, batch_key, idx, data_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id('proposal'), storyId, batchKey, index, json(proposal), env.STORY_PROVIDER, now()));
          db.prepare('UPDATE stories SET status = ?, updated_at = ? WHERE id = ?').run('proposals', now(), storyId); return send(res, 200, responseWithUsage(readStory(db, storyId, ownerId), outcome.job, { batchKey }));
        }
        if (method === 'POST' && action === 'open') {
          const customText = validateCustom(body.customScenario, 5, 200, '自定义情境'); const selected = body.proposal && typeof body.proposal === 'object' ? body.proposal : null; const scenario = customText ? { type: 'custom', title: '我的情境', text: customText, premise: customText, positiveDirection: validateCustom(body.expectation, 1, 100, '期待') || '获得具体、可观察的改善' } : selected;
          if (!scenario || !cleanText(scenario.title) || !cleanText(scenario.premise || scenario.text)) throw problem(400, 'SCENARIO_REQUIRED', '请选择一个情境，或填写自己的情境。');
          db.prepare('UPDATE stories SET scenario_json = ?, expectation = ?, status = ?, updated_at = ? WHERE id = ?').run(json(scenario), validateCustom(body.expectation, 1, 100, '期待'), 'confirmed', now(), storyId);
          const refreshed = readStory(db, storyId, ownerId); const taskInput = taskInputFor('open', refreshed); const existing = refreshed.nodes.find((node) => node.stage === 'opening');
          if (existing) return send(res, 200, responseWithUsage(refreshed, null, { node: existing }));
          const outcome = await execute(ownerId, storyId, 'open', taskInput, () => provider.generate('open', taskInput)); const nodeId = saveNode(storyId, 'opening', outcome.result, null, null); db.prepare('UPDATE stories SET status = ?, updated_at = ? WHERE id = ?').run('opening_ready', now(), storyId); return send(res, 200, responseWithUsage(readStory(db, storyId, ownerId), outcome.job, { node: readStory(db, storyId, ownerId).nodes.find((node) => node.id === nodeId) }));
        }
        if (method === 'POST' && action === 'actions') {
          const stage = body.stage === 2 ? 2 : 1; const actionText = validateCustom(body.actionText, 5, 100, `第${stage}次行动`); const key = cleanText(body.choiceKey); if (!actionText && !['A', 'B'].includes(key)) throw problem(400, 'ACTION_REQUIRED', '请选择一个行动，或填写自定义行动。');
          const current = readStory(db, storyId, ownerId); const opening = current.nodes.find((node) => node.stage === 'opening'); if (!opening) throw problem(409, 'OPENING_REQUIRED', '请先生成故事开场。');
          if (stage === 1) {
            const action = actionText || opening.choices.find((choice) => choice.key === key)?.label; if (!action) throw problem(400, 'ACTION_REQUIRED', '没有找到这个行动。');
            const existing = current.nodes.find((node) => node.parentId === opening.id && node.stage === 'middle' && node.incomingAction === action); if (existing) return send(res, 200, responseWithUsage(current, null, { node: existing, stage: 1 }));
            const input = taskInputFor('advance', current, { routeContext: [opening].map(routeContextNode), selectedAction1: action }); const outcome = await execute(ownerId, storyId, 'advance', input, () => provider.generate('advance', input)); const nodeId = saveNode(storyId, 'middle', outcome.result, opening.id, action); db.prepare('UPDATE stories SET status = ?, updated_at = ? WHERE id = ?').run('middle_ready', now(), storyId); const updated = readStory(db, storyId, ownerId); return send(res, 200, responseWithUsage(updated, outcome.job, { node: updated.nodes.find((node) => node.id === nodeId), stage: 1 }));
          }
          const middles = current.nodes.filter((node) => node.stage === 'middle'); const action1 = cleanText(body.action1) || middles.at(-1)?.incomingAction; const middle = middles.find((node) => node.incomingAction === action1) || middles.at(-1); if (!middle) throw problem(409, 'MIDDLE_REQUIRED', '请先完成第一次行动。');
          const action = actionText || middle.choices.find((choice) => choice.key === key)?.label; if (!action) throw problem(400, 'ACTION_REQUIRED', '没有找到这个行动。');
          const existingRoute = current.routes.find((route) => route.action1 === action1 && route.action2 === action); if (existingRoute) { const node = current.nodes.find((item) => item.id === existingRoute.endingNodeId); return send(res, 200, responseWithUsage(current, null, { node, route: existingRoute, stage: 2 })); }
          if (completedRouteCount(db, storyId) >= int(env, 'MAX_COMPLETED_ROUTES')) throw problem(429, 'ROUTE_LIMIT', '这个故事已经保存了4条完成路线，请查看旧路线或重新开始。');
          const input = taskInputFor('end', current, { routeContext: [opening, middle].map(routeContextNode), selectedAction1: action1, selectedAction2: action }); const outcome = await execute(ownerId, storyId, 'end', input, () => provider.generate('end', input)); const nodeId = saveNode(storyId, 'ending', outcome.result, middle.id, action); const routeId = id('route'); db.prepare('INSERT INTO routes (id, story_id, action1, action2, ending_node_id, positive_outcome, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(routeId, storyId, action1, action, nodeId, outcome.result.data.positiveOutcome, 'ending_ready', now(), now()); db.prepare('UPDATE stories SET status = ?, updated_at = ? WHERE id = ?').run('ending_ready', now(), storyId); const updated = readStory(db, storyId, ownerId); return send(res, 200, responseWithUsage(updated, outcome.job, { node: updated.nodes.find((node) => node.id === nodeId), route: updated.routes.find((route) => route.id === routeId), stage: 2 }));
        }
        if (method === 'POST' && action === 'compilation') {
          const route = story.routes.find((item) => item.id === body.routeId || (item.action1 === body.action1 && item.action2 === body.action2)); if (!route) throw problem(404, 'ROUTE_NOT_FOUND', '找不到要整理的路线。');
          if (route.compilation) return send(res, 200, responseWithUsage(story, null, { route }));
          const ending = story.nodes.find((node) => node.id === route.endingNodeId); const middle = story.nodes.find((node) => node.incomingAction === route.action1 && node.stage === 'middle'); const input = taskInputFor('compile', story, { selectedAction1: route.action1, selectedAction2: route.action2, positiveOutcome: route.positiveOutcome, routeContext: [story.nodes.find((node) => node.stage === 'opening'), middle, ending].filter(Boolean).map((node) => ({ stage: node.stage, text: node.text, incomingAction: node.incomingAction, fixedFacts: node.fixedFacts, events: node.events })) });
          const outcome = await execute(ownerId, storyId, 'compile', input, () => provider.generate('compile', input)); const compiled = outcome.result.data; db.prepare('UPDATE routes SET compilation_title = ?, compilation_text = ?, compilation_version = ?, status = ?, updated_at = ? WHERE id = ?').run(compiled.title, compiled.text, 'compile-v1', 'compiled', now(), route.id); db.prepare('UPDATE stories SET status = ?, updated_at = ? WHERE id = ?').run('compiled', now(), storyId); const updated = readStory(db, storyId, ownerId); return send(res, 200, responseWithUsage(updated, outcome.job, { route: updated.routes.find((item) => item.id === route.id) }));
        }
      }
      const feedback = url.pathname.match(/^\/api\/routes\/([^/]+)\/feedback$/); if (method === 'POST' && feedback) { const route = db.prepare('SELECT r.id FROM routes r JOIN stories s ON s.id = r.story_id WHERE r.id = ? AND s.owner_id = ?').get(feedback[1], ownerId); if (!route) throw problem(404, 'ROUTE_NOT_FOUND', '找不到这条路线。'); const rating = Number(body.rating); if (![1, 2, 3, 4, 5].includes(rating)) throw problem(400, 'INVALID_FEEDBACK', '评分需要是1到5。'); db.prepare('INSERT INTO feedback (id, owner_id, route_id, rating, reasons_json, comment, consent_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id('feedback'), ownerId, route.id, rating, json(body.reasons || []), cleanText(body.comment).slice(0, 500), 'feedback-v1', now()); return send(res, 201, ok({ saved: true })); }
      throw problem(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) { send(res, error.status || 500, publicError(error)); }
  }
  async function serveStatic(res, pathname) {
    const path = resolve(PUBLIC_DIR, pathname || 'index.html'); if (!path.startsWith(PUBLIC_DIR)) return send(res, 403, publicError(problem(403, 'FORBIDDEN', '无法访问该文件。')));
    try { const data = await readFile(path); const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream'; res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(data); } catch { send(res, 404, publicError(problem(404, 'NOT_FOUND', '页面不存在。'))); }
  }
  const server = createHttpServer(handle);
  return {
    server,
    db,
    env,
    handle,
    close: () => {
      db.close();
      try { server.close(); } catch {}
    },
  };
}

export async function start(overrides = {}) {
  const app = await createApp(overrides); const port = Number(app.env.PORT) || 5174; const host = app.env.HOST || '127.0.0.1'; await new Promise((resolvePromise, reject) => { app.server.once('error', reject); app.server.listen(port, host, resolvePromise); }); console.log(`她从何而来 running at http://${host}:${port}`); return app;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) start().catch((error) => { console.error(error); process.exit(1); });
