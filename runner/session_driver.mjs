/** Smart scheduling and limit checks for a discussion hosted inside a free room. */
import { readFileSync } from 'node:fs';
import { api, peer_round_question } from './discussion_runner.mjs';
import { DISCUSSION_PROMPT_VERSION, ROUTE_CONFIDENCE, ROUTE_CONTEXT_MESSAGES, ROUTE_WIDE_CONFIDENCE, decide_interjection, decide_next_speaker, decide_round } from './scheduler.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MAX_QUOTE_CHARS = 300;
/** How many of the latest plans describe "the host's recent arrangement" to the scheduler. */
const ARRANGEMENT_TURNS = 3;
const MAX_ARRANGEMENT_CHARS = 200;
const TURN_STATUS_LABELS = { answered: '已发言', open: '发言中', queued: '排队中', cancelled: '已取消', skipped: '已跳过' };

/** Read every page of current-session discussion plans; the list endpoint is capped at 20 rows per page. */
async function read_all_turns(config) {
  const turns = [];
  let page = 1, pages = 1;
  while (page <= pages) {
    const result = await api(config, `/turns?page=${page}`);
    turns.push(...result.turns);
    pages = result.pages;
    page++;
  }
  return turns;
}

/** Construct the next discussion task without taking over any member execution. */
export class SessionDriver {
  constructor(config, log = () => {}, fetch_impl = fetch) {
    this.config = config;
    this.log = log;
    this.fetch = fetch_impl;
    this.suggestions = new Map();
    this.handled_requests = new Set();
    this.in_flight_requests = new Set();
  }

  /** Run at most one smart scheduling decision for a pending host request. */
  async tick(room, inbox) {
    if (!this.config.scheduler || inbox.archived || room.mode !== 'free' || room.limits?.reached) return false;
    const state = await api(this.config, '/discussion');
    const session = state.session;
    if (!session || session.status !== 'active') return false;
    const members = [...inbox.members, ...(inbox.observers || [])];
    const host = members.find(member => member.role === 'host');
    if (!host) return false;
    if (inbox.executions.some(item => item.member === host.name)) return false;
    const pending_ids = new Set(host.pending.filter(item => item.purpose === 'discuss_host' && item.session_id === session.id).map(item => item.id));
    for (const handled_id of this.handled_requests) if (!pending_ids.has(handled_id)) this.handled_requests.delete(handled_id);
    const request = host.pending.find(item => item.purpose === 'discuss_host' && item.session_id === session.id);
    if (!request || !['user_message', 'speaker_answered', 'round_complete'].includes(request.cause_kind)) return false;
    if (this.handled_requests.has(request.id) || this.in_flight_requests.has(request.id)) return false;

    this.in_flight_requests.add(request.id);
    try {
      const [roster, turns] = await Promise.all([api(this.config, '/turns/roster'), read_all_turns(this.config)]);
      const open_turn = turns.some(turn => ['open', 'queued'].includes(turn.status));
      // An interjection is judged when someone can still be asked or a plan is running that a side note can leave alone.
      const should_decide = request.cause_kind === 'user_message'
        ? roster.waiting.length > 0 || open_turn
        : !open_turn && (roster.waiting.length > 0 || !session.named_followup);
      if (!should_decide) return false;
      this.handled_requests.add(request.id);
      const latest_id = room.latest_id;
      const plan = await this.safe_plan(session, roster, turns, request, room);
      if (!plan) return false;
      const suggestion = { message_id: request.source_message_id || latest_id, suggestion: plan.label,
        confidence: plan.confidence ?? null };

      if (plan.action !== 'schedule' && plan.action !== 'continue') {
        await this.record_decision(plan, false, suggestion.message_id);
        this.suggestions.set(request.id, [suggestion]);
        return false;
      }

      try {
        const current_room = await api(this.config, '');
        if (current_room.latest_id !== latest_id || current_room.session?.id !== session.id || current_room.session?.status !== 'active') {
          throw new Error('讨论期间有新消息或状态变化，交回主持人');
        }
        // The scheduler call may take seconds, so acquire the write credential immediately before posting the plan.
        const latest_roster = await api(this.config, '/turns/roster');
        if (latest_roster.revision !== roster.revision) throw new Error('讨论名单或安排已变化，交回主持人');
        const host_token = this.config.members?.[room.host]?.token;
        if (!host_token) throw new Error('缺少主持人成员凭据，交回主持人');
        // A side note keeps the running plan: closing the host request is all that is needed.
        if (plan.action === 'continue') await api(this.config, '/turns/continue', { actor: room.host, revision: latest_roster.revision }, host_token);
        else await api(this.config, '/turns', { actor: room.host, turns: [plan.turn], roster: latest_roster.revision,
          submission_id: `session-driver-${session.id}-${request.id}` }, host_token);
        await this.record_decision(plan, true, suggestion.message_id);
        this.log(`智能调度 #${request.id}：${plan.label}`);
        return true;
      } catch (error) {
        await this.record_decision({ ...plan, label: `${plan.label}；自动安排失败，交回主持人` }, false, suggestion.message_id);
        this.suggestions.set(request.id, [{ ...suggestion, suggestion: `${suggestion.suggestion}；自动安排失败，交回主持人` }]);
        this.log(`智能调度安排 #${request.id} 失败：${error.message}`);
        return false;
      }
    } finally {
      this.in_flight_requests.delete(request.id);
    }
  }

  /** Return and clear one host request's scheduler suggestions for its task file. */
  take_suggestions(request_id) {
    const result = this.suggestions.get(request_id) || [];
    this.suggestions.delete(request_id);
    return result;
  }

  /** Return control to the host when scheduler input or its provider is unavailable. */
  async safe_plan(session, roster, turns, request, room) {
    try { return await this.plan(session, roster, turns, request, room); }
    catch (error) { this.log(`讨论智能调度 #${request.id} 失败，交回主持人：${error.message}`); return null; }
  }

  /** Choose an eligible next task; manual and web members remain valid candidates from the roster. */
  async plan(session, roster, turns, request, room) {
    const latest_id = room.latest_id || 0;
    const page = await api(this.config, `/messages?after=${Math.max(0, latest_id - ROUTE_CONTEXT_MESSAGES)}`);
    const base = { title: room.title, goal: session.goal || room.goal, user_request: room.user_request,
      context: page.messages, host: room.host, brief: room.host_brief?.text, focus: room.focus, profiles: room.descriptions,
      arrangement: arrangement_of(turns) };
    const last_answer = [...turns].filter(turn => turn.status === 'answered')
      .sort((left, right) => Number(left.answer_id || 0) - Number(right.answer_id || 0)).at(-1);
    const anchor = last_answer?.answer_id || request.source_message_id || latest_id;

    if (request.cause_kind === 'user_message') return this.plan_interjection(base, page.messages, session, roster, request, turns);
    const open = turns.some(turn => ['open', 'queued'].includes(turn.status));
    if (open) return null;
    if (roster.waiting.length) return this.plan_speaker(base, session, roster, turns, anchor);
    if (session.named_followup) return null;
    const experts = roster.experts.filter(item => !item.host && item.registered).map(item => item.name);
    const last_speaker = last_answer?.expert;
    const result = await decide_round(this.config.api_home, this.config.scheduler,
      { ...base, experts, last_speaker }, this.fetch);
    if (result.action !== 'continue') return { ...result, action: 'host', kind: 'round', after_message_id: anchor };
    return { ...result, action: 'schedule', kind: 'round', after_message_id: anchor,
      turn: { expert: result.first, question: peer_round_question(roster.round + 1) } };
  }

  /** Decide whether an unnamed user message should be answered by an expert or returned to the host. */
  async plan_interjection(base, messages, session, roster, request, turns) {
    const message = messages.find(item => item.id === request.source_message_id)
      || messages.find(item => item.author === '用户' && item.id >= (session.held_since || 0));
    if (!message) return null;
    const spoken = turns.filter(turn => turn.round === roster.round && turn.status === 'answered').map(turn => turn.expert);
    const result = await decide_interjection(this.config.api_home, this.config.scheduler,
      { ...base, message, experts: roster.waiting, spoken }, this.fetch);
    if (result.action === 'note') {
      // Continuing needs a plan to continue; with nothing open or queued the discussion would stall without the host.
      if (turns.some(turn => ['open', 'queued'].includes(turn.status))) return { ...result, action: 'continue', kind: 'interjection', after_message_id: message.id };
      return { ...result, action: 'host', kind: 'interjection', after_message_id: message.id, label: '仅补充信息，但当前没有进行中的安排，交给主持人' };
    }
    if (result.action !== 'ask' || !roster.waiting.includes(result.expert)) {
      return { ...result, action: 'host', kind: 'interjection', after_message_id: message.id };
    }
    const quote = String(message.text || '').replace(/\s+/g, ' ').trim();
    const excerpt = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
    return { ...result, action: 'schedule', kind: 'interjection', after_message_id: message.id,
      turn: { expert: result.expert, question: `用户在 #${message.id} 留言：「${excerpt}」请读取原文并先回应这条留言。` } };
  }

  /** Choose a remaining speaker and select opening or peer-round instructions from full turn history. */
  async plan_speaker(base, session, roster, turns, anchor) {
    const ever_spoken = new Set(turns.filter(turn => turn.status === 'answered').map(turn => turn.expert));
    const spoken = turns.filter(turn => turn.round === roster.round && turn.status === 'answered').map(turn => turn.expert);
    const result = await decide_next_speaker(this.config.api_home, this.config.scheduler,
      { ...base, candidates: roster.waiting, spoken }, this.fetch);
    if (result.action !== 'next' || !roster.waiting.includes(result.expert)) {
      return { ...result, action: 'host', kind: 'round', after_message_id: anchor };
    }
    const question = ever_spoken.has(result.expert) ? peer_round_question(roster.round) : opening_question(session.phase);
    return { ...result, action: 'schedule', kind: 'round', after_message_id: anchor,
      turn: { expert: result.expert, question } };
  }

  /** Persist only model decisions; a write failure must leave the host request available. */
  async record_decision(plan, applied, after_message_id) {
    if (!plan.detail) return;
    try {
      await api(this.config, '/scheduler-decisions', { kind: plan.kind, label: plan.label,
        confidence: plan.confidence ?? null, applied, provider: this.config.scheduler.provider,
        after_message_id, detail: plan.detail, input: plan.input,
        context: { model: this.config.scheduler.model, threshold: ROUTE_CONFIDENCE, wide_threshold: ROUTE_WIDE_CONFIDENCE,
          prompt: DISCUSSION_PROMPT_VERSION, package: PACKAGE_VERSION } });
    } catch (error) { this.log(`智能调度决策记录未保存：${error.message}`); }
  }
}

/** The latest plans with their state, as the host's recent arrangement the questions refer to. */
function arrangement_of(turns) {
  return [...turns].sort((left, right) => Number(left.id || 0) - Number(right.id || 0)).slice(-ARRANGEMENT_TURNS).map(turn => {
    const question = String(turn.question || '').replace(/\s+/g, ' ').trim();
    return `${turn.expert}（第 ${turn.round} 轮，${TURN_STATUS_LABELS[turn.status] || turn.status}）：${question.length > MAX_ARRANGEMENT_CHARS ? `${question.slice(0, MAX_ARRANGEMENT_CHARS)}…` : question}`;
  }).join('；');
}

function opening_question(phase) {
  return phase === 'initial' ? '请先独立阅读议题，给出你的开场观点。' : '请先阅读议题和已有回答，给出你的观点。';
}
