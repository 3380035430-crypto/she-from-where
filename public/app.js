const STORAGE_KEY = 'her-origin-story:v1';
const OWNER_KEY = 'her-origin-owner:v1';
const INVITE_KEY = 'her-origin-invite:v1';
const ownerId = localStorage.getItem(OWNER_KEY) || `owner_${crypto.randomUUID().replaceAll('-', '')}`;
localStorage.setItem(OWNER_KEY, ownerId);

const state = {
  story: null,
  proposalBatchKey: null,
  selectedProposal: null,
  customMode: false,
  currentMiddle: null,
  currentRoute: null,
  apiConfigured: false,
};

const $ = (id) => document.getElementById(id);
const views = ['character', 'scenario', 'confirm', 'reading', 'ending', 'compiled'];
const progress = { character: 1, scenario: 2, confirm: 3, reading: 4, ending: 5, compiled: 6 };
const labels = { character: '为她留一个名字', scenario: '找到故事的起点', confirm: '落笔之前', reading: '她要如何回应', ending: '她走到了这里', compiled: '把这段路写下来' };
const generationMessages = [
  '正在把她走过的选择连成一条完整的路。',
  '正在核对人物、事件与已经发生的细节。',
  '正在整理终稿，让故事停在合适的位置。',
];
let generationMessageTimer = null;

const visibleInputErrors = new Set(['INVALID_CHARACTER', 'INVALID_CATEGORY', 'INVALID_INPUT', 'SCENARIO_REQUIRED', 'ACTION_REQUIRED']);
const quietErrors = {
  API_NOT_CONFIGURED: '她还没有回应，请稍后再来。',
  API_UNAUTHORIZED: '这段路暂时没有回应，请稍后再试。',
  API_BALANCE: '今天能点亮的岔路已经走到尽头，明天再来。',
  API_RATE_LIMIT: '此刻人声太近了，请过一会儿再来。',
  API_ERROR: '这一页暂时没有回应，请稍后再试。',
  API_TIMEOUT: '她走得有些慢，请稍后再试。',
  API_NETWORK_ERROR: '这一页暂时没有回应，请检查连接后再试。',
  MODEL_FORMAT_ERROR: '这一页还没有整理好，请稍后再试。',
  COMPILE_LENGTH_ERROR: '这一页还没有整理妥当。过一会儿再翻开看看，她会继续把余下的路写完。',
  DAILY_REQUEST_LIMIT: '今天能点亮的岔路已经用完，明天再来。',
  DAILY_BUDGET_LIMIT: '今天能点亮的岔路已经用完，明天再来。',
  TOTAL_BUDGET_LIMIT: '这段试行的路已经走到尽头。',
  PROPOSAL_LIMIT: '今天能听见的起点已经够多了，明天再来。',
  STORY_LIMIT: '新的故事名额已经用完，请从已有的来路继续。',
  ROUTE_LIMIT: '这段故事已经留下了足够多的来路，请回看已经走过的选择。',
  STORY_NOT_FOUND: '这段故事已经走远了，请重新开始。',
  OWNER_BUSY: '她正在回应上一句话，请等这一页安静下来。',
  GLOBAL_BUSY: '此刻人声太近了，请过一会儿再来。',
  JOB_RUNNING: '她正在回应上一句话，请等这一页安静下来。',
};

function friendlyError(error) {
  if (visibleInputErrors.has(error?.code)) return error.message;
  return quietErrors[error?.code] || '这一页暂时没有回应，请稍后再试。';
}

function setAccessMessage(message = '') {
  const node = $('access-message');
  if (!node) return;
  node.hidden = !message;
  node.textContent = message;
}

async function verifyInvite(inviteCode) {
  const response = await fetch('/api/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteCode }),
  });
  const payload = await response.json().catch(() => ({ ok: false }));
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.error?.message || '这枚体验码还没有让这段路亮起来，请再确认一次。');
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

async function waitForAccess() {
  const gate = $('access-gate');
  const form = $('access-form');
  const input = $('access-code');
  if (!gate || !form || !input) return;
  gate.hidden = false;
  document.body.classList.add('access-locked');
  const savedCode = sessionStorage.getItem(INVITE_KEY) || '';
  if (savedCode) {
    try {
      await verifyInvite(savedCode);
      gate.hidden = true;
      document.body.classList.remove('access-locked');
      initPrologue();
      return;
    } catch {
      sessionStorage.removeItem(INVITE_KEY);
    }
  }
  await new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      setAccessMessage('');
      try {
        const code = input.value.trim();
        await verifyInvite(code);
        sessionStorage.setItem(INVITE_KEY, code);
        gate.hidden = true;
        document.body.classList.remove('access-locked');
        initPrologue();
        resolve();
      } catch (error) {
        setAccessMessage(error.message || '这枚体验码还没有让这段路亮起来，请再确认一次。');
        input.select();
      } finally {
        button.disabled = false;
      }
    }, { once: false });
  });
}

function initPrologue() {
  const prologue = $('prologue');
  const copy = prologue?.querySelector('.prologue-copy');
  const enter = $('enter-story');
  if (!prologue || !copy || !enter) return;
  document.body.classList.add('prologue-active');

  const moveLight = (event) => {
    const point = event.touches?.[0] || event;
    if (!point) return;
    const rect = prologue.getBoundingClientRect();
    prologue.style.setProperty('--light-x', `${point.clientX - rect.left}px`);
    prologue.style.setProperty('--light-y', `${point.clientY - rect.top}px`);
    prologue.style.setProperty('--light-opacity', '1');
  };
  const reveal = (event) => {
    moveLight(event);
    if (prologue.classList.contains('revealed')) return;
    event.preventDefault();
    prologue.classList.add('revealed');
    copy.hidden = false;
    requestAnimationFrame(() => {
      prologue.style.setProperty('--light-x', '50%');
      prologue.style.setProperty('--light-y', '50%');
    });
  };
  const dismiss = () => {
    prologue.classList.add('leaving');
    document.body.classList.remove('prologue-active');
    window.setTimeout(() => { prologue.hidden = true; }, 650);
  };

  prologue.addEventListener('pointermove', moveLight);
  prologue.addEventListener('pointerdown', reveal);
  prologue.addEventListener('touchmove', moveLight, { passive: true });
  enter.addEventListener('click', dismiss);
}

function setNotice(message = '', type = 'error') {
  const node = $('notice');
  node.hidden = !message;
  node.textContent = message;
  node.className = `notice ${type === 'success' ? 'success' : ''}`;
}

function setLoading(container, count = 1) {
  container.replaceChildren(...Array.from({ length: count }, () => { const div = document.createElement('div'); div.className = 'skeleton'; return div; }));
}

function setStoryGenerating(active) {
  const generator = $('story-generator');
  const main = document.querySelector('main');
  if (!generator || !main) return;
  window.clearInterval(generationMessageTimer);
  generationMessageTimer = null;
  generator.hidden = !active;
  document.body.classList.toggle('story-generating', active);
  main.setAttribute('aria-busy', String(active));
  if (!active) return;

  let messageIndex = 0;
  $('generation-message').textContent = generationMessages[messageIndex];
  generationMessageTimer = window.setInterval(() => {
    messageIndex = (messageIndex + 1) % generationMessages.length;
    $('generation-message').textContent = generationMessages[messageIndex];
  }, 4200);
}

function setView(name) {
  views.forEach((view) => $(`view-${view}`).classList.toggle('active', view === name));
  $('progress-step').textContent = labels[name];
  $('progress-count').textContent = `${progress[name]} / 6`;
  $('progress-bar').style.width = `${(progress[name] / 6) * 100}%`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ storyId: state.story?.id || null, lastView: state.story ? inferView() : 'character' })); } catch { setNotice('这一页没有被留住，但你仍可以继续走下去或把故事带走。'); }
}
function inferView() {
  if (!state.story) return 'character';
  if (state.currentRoute?.compilation) return 'compiled';
  if (state.currentRoute) return 'ending';
  if (state.currentMiddle || state.story.nodes.some((node) => node.stage === 'opening')) return 'reading';
  if (state.story.proposals.length) return 'scenario';
  return 'character';
}

async function api(path, options = {}) {
  const inviteCode = sessionStorage.getItem(INVITE_KEY) || '';
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-owner-id': ownerId, ...(inviteCode ? { 'x-invite-code': inviteCode } : {}), ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({ ok: false, error: { code: 'INVALID_RESPONSE' } }));
  if (!response.ok || !payload.ok) { const error = new Error(payload.error?.message || '这一页暂时没有回应，请稍后再试。'); error.code = payload.error?.code; throw error; }
  return payload;
}

function body(data) { return { method: 'POST', body: JSON.stringify(data) }; }
function selectedCategory() { return document.querySelector('input[name="category"]:checked')?.value || 'family'; }
function traits() { return $('traits').value.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 2); }
function activeProposals() { return state.story?.proposals.filter((proposal) => !state.proposalBatchKey || proposal.batchKey === state.proposalBatchKey) || []; }
function latestNode(stage) { return state.story?.nodes.filter((node) => node.stage === stage).at(-1); }
function selectedScenario() { return state.customMode ? { type: 'custom', text: $('custom-scenario').value.trim(), title: '我的情境', premise: $('custom-scenario').value.trim(), positiveDirection: $('scenario-expectation').value.trim() || '获得具体、可观察的改善' } : state.selectedProposal; }

function renderProposalList() {
  const list = $('proposal-list'); list.replaceChildren();
  const proposals = activeProposals();
  if (!proposals.length) { setLoading(list, 3); return; }
  proposals.forEach((proposal, index) => {
    const card = document.createElement('label'); card.className = `proposal-card${!state.customMode && state.selectedProposal?.id === proposal.id ? ' selected' : ''}`;
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'proposal'; input.checked = !state.customMode && state.selectedProposal?.id === proposal.id;
    const indexNode = document.createElement('span'); indexNode.className = 'proposal-index'; indexNode.textContent = String(index + 1).padStart(2, '0');
    const content = document.createElement('div'); const title = document.createElement('h3'); title.textContent = proposal.title; const premise = document.createElement('p'); premise.textContent = proposal.premise; const direction = document.createElement('small'); direction.textContent = `她也许会走向：${proposal.positiveDirection}`;
    content.append(title, premise, direction); card.append(input, indexNode, content);
    card.addEventListener('click', () => { state.selectedProposal = proposal; state.customMode = false; $('custom-panel').hidden = true; updateConfirmButton(); renderProposalList(); });
    list.append(card);
  });
}

function updateConfirmButton() {
  const custom = $('custom-scenario').value.trim(); $('confirm-scenario').disabled = state.customMode ? custom.length < 5 : !state.selectedProposal;
}

function renderConfirm() {
  const scenario = selectedScenario(); const card = $('confirm-card'); card.replaceChildren();
  const title = document.createElement('h2'); title.textContent = scenario?.title || '我的情境'; const premise = document.createElement('p'); premise.textContent = scenario?.premise || scenario?.text || '';
  const direction = document.createElement('span'); direction.className = 'confirm-direction'; direction.textContent = `她也许会走向：${scenario?.positiveDirection || $('scenario-expectation').value.trim() || '由她自己走出具体的下一步'}`;
  card.append(title, premise, direction); setView('confirm');
}

function renderTimeline() {
  const timeline = $('reading-timeline'); timeline.replaceChildren(); const opening = latestNode('opening'); if (!opening) return;
  timeline.append(storyNode(opening, '故事初见'));
  if (state.currentMiddle) timeline.append(storyNode(state.currentMiddle, '她走过第一个岔路口'));
}
function storyNode(node, label) {
  const article = document.createElement('article'); article.className = 'story-card story-node'; const tag = document.createElement('p'); tag.className = 'eyebrow'; tag.textContent = label; const text = document.createElement('div'); text.className = 'story-text'; text.textContent = node.text; article.append(tag, text); return article;
}
function renderChoicePanel() {
  const panel = $('choice-panel'); panel.replaceChildren(); const stage = state.currentMiddle ? 2 : 1; const node = state.currentMiddle || latestNode('opening');
  if (!node) return;
  $('reading-stage').textContent = `第${stage}次选择 · 她可以怎么做`;
  $('reading-title').textContent = stage === 1 ? '她站在故事的第一个岔路口。' : '新的信息来到她面前。';
  const heading = document.createElement('h2'); heading.textContent = stage === 1 ? '这一次，她想先做什么？' : '接下来，她要把什么放在前面？'; panel.append(heading);
  const actions = document.createElement('div'); actions.className = 'action-list'; node.choices.forEach((choice) => actions.append(actionButton(choice, stage))); panel.append(actions);
  const custom = document.createElement('div'); custom.className = 'custom-action'; const input = document.createElement('input'); input.id = `custom-action-${stage}`; input.maxLength = 100; input.placeholder = '或者写下她自己的行动，5–100字'; const button = document.createElement('button'); button.className = 'secondary-button'; button.type = 'button'; button.textContent = '让她这样走'; button.addEventListener('click', () => submitAction(stage, '', input.value)); custom.append(input, button); panel.append(custom);
}
function actionButton(choice, stage) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'action-button'; const key = document.createElement('span'); key.className = 'action-key'; key.textContent = choice.key; const text = document.createElement('span'); text.textContent = choice.label; button.append(key, text); button.addEventListener('click', () => submitAction(stage, choice.key, '')); return button;
}
function renderReading() { renderTimeline(); renderChoicePanel(); setView('reading'); }

function renderEnding() {
  const route = state.currentRoute; const ending = state.story?.nodes.find((node) => node.id === route?.endingNodeId); const card = $('ending-card'); card.replaceChildren();
  if (!ending) return;
  const text = document.createElement('div'); text.className = 'story-text'; text.textContent = ending.text; const outcome = document.createElement('div'); outcome.className = 'ending-outcome'; outcome.textContent = `她因此得到：${route.positiveOutcome}`; card.append(text, outcome); renderRoutes(); setView('ending');
}
function renderRoutes() {
  const list = $('route-list'); list.replaceChildren(); const routes = state.story?.routes || []; if (!routes.length) return; const heading = document.createElement('h2'); heading.textContent = '她走过的几条路'; const items = document.createElement('div'); items.className = 'route-list'; routes.forEach((route, index) => { const button = document.createElement('button'); button.className = 'route-item'; button.type = 'button'; const label = document.createElement('span'); label.textContent = `来路 ${index + 1}`; const detail = document.createElement('small'); detail.textContent = route.compilation ? '这一页已经写下' : '她已经走到这里'; button.append(label, detail); button.addEventListener('click', () => { state.currentRoute = route; if (route.compilation) renderCompiled(); else renderEnding(); }); items.append(button); }); list.append(heading, items);
}
function renderCompiled() {
  const card = $('compiled-card'); card.replaceChildren(); const compilation = state.currentRoute?.compilation; if (!compilation) return;
  const title = document.createElement('h2'); title.textContent = compilation.title; const text = document.createElement('div'); text.className = 'compiled-text'; text.textContent = compilation.text; const meta = document.createElement('p'); meta.className = 'compiled-meta'; meta.textContent = `${[...compilation.text.replace(/\s/g, '')].length} 字 · 她走过的这一页`; card.append(title, text, meta); setView('compiled');
}

async function loadProposals() {
  const list = $('proposal-list'); setLoading(list, 3); $('confirm-scenario').disabled = true;
  try {
    const batchKey = state.proposalBatchKey || `batch_${Date.now()}`; const excluded = (state.story?.proposals || []).map(({ title, premise }) => ({ title, premise })); const result = await api(`/api/stories/${state.story.id}/proposals`, body({ batchKey, excludedProposalSummaries: excluded })); state.story = result.story; state.proposalBatchKey = result.batchKey || batchKey; state.selectedProposal = null; state.customMode = false; renderProposalList(); updateConfirmButton(); updateUsage(result.usage); saveLocal();
  } catch (error) { setNotice(friendlyError(error)); renderProposalList(); }
}
async function createSession(event) {
  event.preventDefault(); setNotice(''); const submit = event.submitter; submit.disabled = true;
  try {
    const result = await api('/api/session', body({ character: { name: $('character-name').value, lifeStage: $('life-stage').value, traits: traits() }, category: selectedCategory(), expectation: '' })); state.story = result.story; state.proposalBatchKey = null; saveLocal(); setView('scenario'); await loadProposals();
  } catch (error) { setNotice(friendlyError(error)); } finally { submit.disabled = false; }
}
async function startStory() {
  const button = $('start-story'); button.disabled = true; setNotice('她正在走近这件事。', 'success');
  try { const scenario = selectedScenario(); const result = await api(`/api/stories/${state.story.id}/open`, body({ proposal: state.customMode ? null : scenario, customScenario: state.customMode ? $('custom-scenario').value : '', expectation: $('scenario-expectation').value })); state.story = result.story; state.currentMiddle = null; state.currentRoute = null; setNotice(''); updateUsage(result.usage); saveLocal(); renderReading(); } catch (error) { setNotice(friendlyError(error)); } finally { button.disabled = false; }
}
async function submitAction(stage, choiceKey, actionText) {
  const buttonSet = $('choice-panel').querySelectorAll('button'); buttonSet.forEach((button) => { button.disabled = true; }); setNotice('她已经做出选择，故事正在向前。', 'success');
  try {
    const payload = { stage, choiceKey, actionText }; if (stage === 2) payload.action1 = state.currentMiddle?.incomingAction;
    const result = await api(`/api/stories/${state.story.id}/actions`, body(payload)); state.story = result.story; updateUsage(result.usage); setNotice('');
    if (stage === 1) { state.currentMiddle = result.node; renderReading(); } else { state.currentRoute = result.route; renderEnding(); }
    saveLocal();
  } catch (error) { setNotice(friendlyError(error)); buttonSet.forEach((button) => { button.disabled = false; }); }
}
async function compileStory() {
  const button = $('compile-story'); button.disabled = true; setNotice(''); setStoryGenerating(true);
  const startedAt = performance.now();
  try {
    const result = await api(`/api/stories/${state.story.id}/compilation`, body({ routeId: state.currentRoute.id }));
    const remainingDisplayTime = Math.max(0, 1100 - (performance.now() - startedAt));
    if (remainingDisplayTime) await new Promise((resolve) => window.setTimeout(resolve, remainingDisplayTime));
    state.story = result.story; state.currentRoute = result.route; updateUsage(result.usage); saveLocal(); renderCompiled();
  } catch (error) { setNotice(friendlyError(error)); } finally { setStoryGenerating(false); button.disabled = false; }
}
function updateUsage(usage) { if (!usage) return; state.apiConfigured = usage.provider === 'mock' || state.apiConfigured; }
function selectRestoreView() {
  if (!state.story) return setView('character');
  if (!state.story.nodes.length && state.story.proposals.length) { state.proposalBatchKey = state.story.proposals.at(-1).batchKey; renderProposalList(); updateConfirmButton(); return setView('scenario'); }
  const endingRoute = state.story.routes.at(-1); if (endingRoute) { state.currentRoute = endingRoute; if (endingRoute.compilation) return renderCompiled(); return renderEnding(); }
  const middle = state.story.nodes.filter((node) => node.stage === 'middle').at(-1); if (middle) { state.currentMiddle = middle; return renderReading(); }
  if (latestNode('opening')) return renderReading();
  setView('character');
}

async function boot() {
  $('character-form').addEventListener('submit', createSession); $('confirm-scenario').addEventListener('click', renderConfirm); $('start-story').addEventListener('click', startStory);
  $('show-custom').addEventListener('click', () => { state.customMode = true; state.selectedProposal = null; $('custom-panel').hidden = false; updateConfirmButton(); renderProposalList(); }); $('custom-scenario').addEventListener('input', () => { $('scenario-count').textContent = $('custom-scenario').value.length; updateConfirmButton(); }); $('scenario-expectation').addEventListener('input', updateConfirmButton);
  $('refresh-proposals').addEventListener('click', async () => { state.proposalBatchKey = `batch_${Date.now()}`; await loadProposals(); }); $('back-character').addEventListener('click', () => setView('character')); $('edit-scenario').addEventListener('click', () => setView('scenario')); $('other-route').addEventListener('click', () => { state.currentMiddle = null; state.currentRoute = null; setNotice('回到第一次选择，已经完成的路线仍然保留。', 'success'); renderReading(); }); $('compile-story').addEventListener('click', compileStory); $('back-ending').addEventListener('click', renderEnding);
  $('copy-story').addEventListener('click', async () => { const text = `${state.currentRoute.compilation.title}\n\n${state.currentRoute.compilation.text}`; try { await navigator.clipboard.writeText(text); setNotice('完整短篇已经复制。', 'success'); } catch { setNotice('浏览器拒绝了复制操作，请手动选中正文。'); } }); $('download-story').addEventListener('click', () => { const compilation = state.currentRoute.compilation; const blob = new Blob([`${compilation.title}\n\n${compilation.text}`], { type: 'text/plain;charset=utf-8' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${(state.story.character.name || '她')}-${compilation.title}.txt`; link.click(); URL.revokeObjectURL(link.href); });
  $('reset-story').addEventListener('click', async () => { if (state.story) { try { await api(`/api/stories/${state.story.id}`, { method: 'DELETE', body: '{}' }); } catch {} } localStorage.removeItem(STORAGE_KEY); window.location.reload(); });
  try {
    const health = await fetch('/api/health').then((response) => response.json());
    state.apiConfigured = Boolean(health.generationAvailable);
    if (health.inviteRequired) await waitForAccess();
    else initPrologue();
  } catch {
    state.apiConfigured = false;
    initPrologue();
  }
  const requestedStoryId = new URLSearchParams(window.location.search).get('story');
  const saved = requestedStoryId ? { storyId: requestedStoryId } : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (saved?.storyId) {
    try {
      const result = await api(`/api/stories/${saved.storyId}`);
      state.story = result.story;
      state.proposalBatchKey = state.story.proposals.at(-1)?.batchKey || null;
      saveLocal();
      if (requestedStoryId) window.history.replaceState({}, '', window.location.pathname);
      selectRestoreView();
    } catch {
      if (!requestedStoryId) localStorage.removeItem(STORAGE_KEY);
      setView('character');
    }
  } else setView('character');
}

boot();
