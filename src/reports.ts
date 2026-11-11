import { AuthError, authNow, requireAccount, sha256, type Account, type AuthEnv } from './auth';
import { consumeRate } from './account-business';
import { readRequestBytes } from './request-body';

type ReportEnv = AuthEnv & { IMAGES: KVNamespace; REPORT_POLICY_OWNER_ACCOUNT_ID?: string };
export type ReportPolicy = {
  initialScore: number; minimumScore: number; minimumReportScore: number;
  successLimit: number; pendingPerPair: number; pendingTargets: number;
  failureWindowSeconds: number; upheldPenalty: number;
  failureBands: { through: number | null; points: number }[];
  reasonMinLength: number; reasonMaxLength: number; reviewReasonMaxLength: number;
  submissionsPerThread: number; rateWindowSeconds: number; pageSize: number; maxPageSize: number;
};
type Policy = { id: string; policy: ReportPolicy };
type Case = {
  id: string; reporter_id: string; target_id: string; thread_id: string; message_id: string;
  reporter_role: string; target_label: string; thread_title: string; snapshot: string; reason: string;
  request_key: string; fingerprint: string; created_at: number; creation_policy_id: string;
  status: 'pending' | 'upheld' | 'rejected'; review_reason: string | null; decided_at: number | null;
  decision_policy_id: string | null; affected_id: string | null; nominal_penalty: number | null;
  score_before: number | null; score_after: number | null;
};
type Source = { id: string; thread_id: string; role: string; body: string; draw: number; created_at: number;
  author_account_id: string | null; account_id: string | null; operator_id: string; title: string;
  owner_account_id: string | null; operator_uid: string | null; active: number | null; target_verified: number | null; home: string | null };
const fail = (status: number, code: string, message: string): never => { throw new AuthError(status, code, message); };
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const keyValid = (v: string) => /^[A-Za-z0-9_-]{8,100}$/.test(v);
async function body(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readRequestBytes(request, 16_000, () => new AuthError(413, 'REPORT_BODY_LIMIT', '内容太长了。'));
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); if (!value || Array.isArray(value) || typeof value !== 'object') throw 0; return value; }
  catch { return fail(400, 'REPORT_BODY_INVALID', '提交内容不正确。'); }
}
async function current(env: ReportEnv): Promise<Policy> {
  const row = await env.DB.prepare('SELECT id,policy FROM report_current_policy').first<{ id: string; policy: string }>();
  if (!row) return fail(503, 'REPORT_POLICY_UNAVAILABLE', '举报暂时不可用，请稍后重试。');
  return { id: row.id, policy: JSON.parse(row.policy) };
}
async function admin(request: Request, env: ReportEnv, owner = false): Promise<Account> {
  const account = await requireAccount(request, env);
  assertAdmin(account,env,owner);
  return account;
}
function assertAdmin(account: Account, env: ReportEnv, owner = false): void {
  const policyOwner = env.REPORT_POLICY_OWNER_ACCOUNT_ID ? account.id === env.REPORT_POLICY_OWNER_ACCOUNT_ID : account.home;
  if (!account.roles.includes('admin') || owner && !policyOwner) return fail(403, 'REPORT_ADMIN_REQUIRED', '没有操作权限。');
}
async function find(env: ReportEnv, id: string): Promise<Case> {
  const row = await env.DB.prepare('SELECT * FROM reports WHERE id=?').bind(id).first<Case>();
  if (!row) return fail(404, 'REPORT_NOT_FOUND', '举报记录不存在。'); return row;
}
function mayRead(row: Case, account: Account) {
  return account.roles.includes('admin') || row.reporter_id === account.id || row.status === 'upheld' && row.target_id === account.id;
}
function dto(row: Case, account: Account, detail = false) {
  const own = row.affected_id === account.id;
  const result: Record<string, unknown> = { id: row.id, title: row.thread_title, reason: row.reason, status: row.status,
    targetLabel: row.reporter_id === account.id ? row.target_label : null,
    direction: row.reporter_id === account.id ? 'sent' : 'received', createdAt: row.created_at, decidedAt: row.decided_at,
    reviewReason: row.review_reason, deduction: own ? Number(row.score_before) - Number(row.score_after) : 0,
    scoreBefore: own ? row.score_before : null, scoreAfter: own ? row.score_after : null };
  if (detail) result.message = JSON.parse(row.snapshot);
  if (account.roles.includes('admin')) Object.assign(result, { reporterId: row.reporter_id, targetId: row.target_id,
    targetLabel: row.target_label, threadId: row.thread_id, reporterRole: row.reporter_role,
    nominalPenalty: row.nominal_penalty, scoreBefore: row.score_before, scoreAfter: row.score_after,
    creationPolicy: row.creation_policy_id, decisionPolicy: row.decision_policy_id });
  return result;
}
async function details(env: ReportEnv, row: Case, account: Account) {
  if (!mayRead(row, account)) return fail(404, 'REPORT_NOT_FOUND', '举报记录不存在。');
  const images = await env.DB.prepare('SELECT image_id,image_type FROM report_images WHERE report_id=? ORDER BY position,image_id')
    .bind(row.id).all<{ image_id: string; image_type: string }>();
  const result = { ...dto(row, account, true), images: images.results.map(i => ({ id: i.image_id, type: i.image_type,
    url: `/api/reports/${row.id}/images/${i.image_id}` })) };
  if (account.roles.includes('admin')) {
    const scores = await env.DB.prepare('SELECT account_id,score FROM account_reputations WHERE account_id IN (?,?)')
      .bind(row.reporter_id,row.target_id).all<{account_id:string;score:number}>();
    const policy = await current(env);
    const thread = await env.DB.prepare("SELECT 1 AS found FROM threads WHERE id=?").bind(row.thread_id).first();
    Object.assign(result,{threadAvailable:Boolean(thread),reporterScore:scores.results.find(s=>s.account_id===row.reporter_id)?.score,
      targetScore:scores.results.find(s=>s.account_id===row.target_id)?.score,reviewReasonMaxLength:policy.policy.reviewReasonMaxLength});
  }
  return result;
}
const sourceSQL = `SELECT m.id,m.thread_id,m.role,m.body,m.draw,m.created_at,m.author_account_id,
  t.account_id,t.operator_id,t.title,o.owner_account_id,o.operator_uid,o.active,a.verified_at AS target_verified,
  (SELECT value FROM settings WHERE key='home_owner_account_id') AS home
  FROM messages m JOIN threads t ON t.id=m.thread_id LEFT JOIN operators o ON o.id=t.operator_id
  LEFT JOIN accounts a ON a.id=m.author_account_id`;
function sourceRole(row: Source, account: Account): 'visitor' | 'operator' | null {
  if (!row.author_account_id || !row.target_verified || row.author_account_id === account.id) return null;
  if (row.role === 'tangbao' && row.account_id === account.id) return 'visitor';
  if (row.role === 'visitor' && (account.roles.includes('operator') || account.roles.includes('admin')) &&
    (row.active === 1 && row.owner_account_id === account.id || row.operator_id === 'tangbao-vme50-flash' &&
      row.home === account.id && account.roles.includes('admin'))) return 'operator';
  return null;
}
async function pairState(env: ReportEnv, reporter: string, target: string, p: ReportPolicy) {
  const row = await env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM report_pairs WHERE reporter_id=? AND target_id=? AND (locked_at>0 OR success_count>=success_limit)) AS locked,
    (SELECT id FROM reports WHERE reporter_id=? AND target_id=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1) AS pending,
    (SELECT count(*) FROM reports WHERE reporter_id=? AND target_id=? AND status='pending') AS pendingCount,
    (SELECT success_limit-success_count FROM report_pairs WHERE reporter_id=? AND target_id=?) AS remaining,
    (SELECT count(DISTINCT target_id) FROM reports WHERE reporter_id=? AND status='pending') AS targets,
    (SELECT score FROM account_reputations WHERE account_id=?) AS score`)
    .bind(reporter, target, reporter, target, reporter, target, reporter, target, reporter, reporter).first<{ locked: number; pending: string | null; pendingCount:number; remaining:number|null; targets: number; score: number }>();
  if (!row || row.score === null) return fail(503, 'REPORT_STATE_UNAVAILABLE', '举报暂时不可用。');
  return { state: row.locked ? 'locked' : row.pendingCount >= Math.min(p.pendingPerPair,row.remaining ?? p.successLimit) ? 'pending' : row.score < p.minimumReportScore ? 'restricted' : 'available',
    reportId: row.pending, pendingCount:row.pendingCount, targets: row.targets, score: row.score };
}
const errors: Record<string, [number, string]> = {
  REPORT_PAIR_LOCKED: [409, '你已成功举报过该账号。'], REPORT_PAIR_PENDING: [409, '对该账号的举报正在审核。'],
  REPORT_PENDING_LIMIT: [409, '待审核的举报已达上限。'], REPORT_REPUTATION_LOW: [403, '信誉分不足，暂时不能举报。'],
  REPORT_ACCOUNT_REQUIRED: [403, '双方都有已验证的账号才可举报。'], REPORT_MESSAGE_FORBIDDEN: [403, '这条消息无法举报。'],
  REPORT_IMPACT_CHANGED: [409, '扣分结果已变化，请重新确认。'], REPORT_POLICY_CHANGED: [409, '举报规则已更新，请重试。'],
  REPORT_REASON_INVALID: [400, '请填写有效的举报原因。'], REPORT_IMMUTABLE: [409, '该举报已处理，请刷新查看结果。'],
  REPORT_REVIEW_REASON_INVALID: [400, '请填写审核原因。'], REPORT_ADMIN_REQUIRED: [403, '没有审核权限。'],
};
function databaseError(error: unknown): never {
  const message = String(error);
  for (const [code, [status, note]] of Object.entries(errors)) if (message.includes(code)) return fail(status, code, note);
  throw error;
}
async function create(request: Request, env: ReportEnv, account: Account, data: Record<string, unknown>, thread?: string) {
  let messageId = text(data.messageId);
  // The old thread endpoint is an adapter, with a stable key for old clients.
  if (!messageId && thread) {
    const row = await env.DB.prepare(`${sourceSQL} WHERE t.id=? AND m.role='tangbao' AND t.account_id=?
      AND m.author_account_id IS NOT NULL ORDER BY m.rowid DESC LIMIT 1`).bind(thread, account.id).first<Source>();
    if (row && sourceRole(row, account)) messageId = row.id;
  }
  const reason = text(data.reason).replace(/\u0000/g, '');
  const fingerprint = await sha256(JSON.stringify([messageId, reason]));
  const requestKey = text(data.requestKey) || (thread ? `legacy_${fingerprint}` : '');
  if (!keyValid(requestKey)) return fail(400, 'REPORT_REQUEST_KEY', '请重新打开举报窗口。');
  const replay = async () => env.DB.prepare('SELECT * FROM reports WHERE reporter_id=? AND request_key=?').bind(account.id, requestKey).first<Case>();
  const previous = await replay();
  if (previous) {
    if (previous.fingerprint !== fingerprint) return fail(409, 'REPORT_KEY_REUSED', '同一次提交的内容已变化，请重新打开举报窗口。');
    return reply({ report: await details(env, previous, account), replayed: true });
  }
  const p = await current(env);
  if ([...reason].length < p.policy.reasonMinLength || [...reason].length > p.policy.reasonMaxLength)
    return fail(400, 'REPORT_REASON_INVALID', `举报原因须为${p.policy.reasonMinLength}至${p.policy.reasonMaxLength}个字。`);
  const source = await env.DB.prepare(`${sourceSQL} WHERE m.id=?`).bind(messageId).first<Source>();
  const role = source && sourceRole(source, account);
  if (!source || !role || thread && source.thread_id !== thread) return fail(403, 'REPORT_MESSAGE_FORBIDDEN', '这条消息无法举报。');
  const target = source.author_account_id!;
  const state = await pairState(env, account.id, target, p.policy);
  if (state.state === 'locked') return fail(409, 'REPORT_PAIR_LOCKED', '你已成功举报过该账号。');
  if (state.state === 'pending') return fail(409, 'REPORT_PAIR_PENDING', '对该账号的举报正在审核。');
  if (state.score < p.policy.minimumReportScore) return fail(403, 'REPORT_REPUTATION_LOW', `${p.policy.minimumReportScore}分以下不能发起举报。`);
  if (!state.pendingCount && state.targets >= p.policy.pendingTargets) return fail(409, 'REPORT_PENDING_LIMIT', '待审核的举报已达上限。');
  if (!await consumeRate(env, `report:${account.id}:${source.thread_id}`, p.policy.submissionsPerThread, p.policy.rateWindowSeconds * 1000))
    return fail(429, 'REPORT_RATE_LIMIT', '举报过于频繁，请稍后再试。');
  const context = await env.DB.prepare(`SELECT role,body,created_at AS createdAt FROM messages
    WHERE thread_id=? AND rowid<(SELECT rowid FROM messages WHERE id=?) ORDER BY rowid DESC LIMIT 4`)
    .bind(source.thread_id, source.id).all();
  const snapshot = JSON.stringify({ body: source.body, role: source.role, createdAt: source.created_at, draw: source.draw,
    context: context.results.reverse() });
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO reports(id,reporter_id,target_id,thread_id,message_id,reporter_role,target_label,model_uid,
      thread_title,snapshot,reason,request_key,fingerprint,created_at,creation_policy_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, account.id, target, source.thread_id, source.id, role, role === 'visitor' ? source.operator_id : '用户', source.operator_uid || source.operator_id,
        source.title, snapshot, reason, requestKey, fingerprint, authNow(env), p.id).run();
  } catch (error) {
    const recovered = await replay().catch(() => null);
    if (recovered) {
      if (recovered.fingerprint !== fingerprint) return fail(409, 'REPORT_KEY_REUSED', '同一次提交的内容已变化。');
      return reply({ report: await details(env, recovered, account), replayed: true });
    }
    try { databaseError(error); } catch (mapped) { if (mapped instanceof AuthError) throw mapped; }
    return fail(503, 'REPORT_WRITE_UNKNOWN', '提交结果暂时无法确认，请保留当前窗口，稍后重试。');
  }
  return reply({ report: await details(env, await find(env, id), account) }, 201);
}
export function validateReportPolicy(value: unknown): ReportPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'REPORT_POLICY_INVALID', '规则格式不正确。');
  const p = value as ReportPolicy;
  const bounds: Record<string, [number, number]> = { initialScore: [1,100], minimumScore: [0,99], minimumReportScore: [1,100],
    successLimit: [1,10], pendingPerPair: [1,10], pendingTargets: [1,20], failureWindowSeconds: [1,31536000],
    upheldPenalty: [1,100], reasonMinLength: [1,100], reasonMaxLength: [1,2000], reviewReasonMaxLength: [1,2000],
    submissionsPerThread: [1,100], rateWindowSeconds: [1,86400], pageSize: [1,50], maxPageSize: [1,50] };
  if (Object.keys(p).some(k => !(k in bounds) && k !== 'failureBands') || Object.keys(bounds).some(k => {
    const n = (p as unknown as Record<string, number>)[k]; return !Number.isSafeInteger(n) || n < bounds[k][0] || n > bounds[k][1];
  }) || !(p.minimumScore < p.minimumReportScore && p.minimumReportScore <= p.initialScore) ||
    p.pendingPerPair > p.successLimit || p.reasonMinLength > p.reasonMaxLength || p.pageSize > p.maxPageSize ||
    !Array.isArray(p.failureBands) || !p.failureBands.length || p.failureBands.length > 20)
    return fail(400, 'REPORT_POLICY_INVALID', '规则取值或边界不正确。');
  let previous = 0, previousPoints = 0;
  p.failureBands.forEach((band, i) => {
    if (!band || !Number.isSafeInteger(band.points) || band.points < 1 || band.points > 100 || band.points < previousPoints ||
      (i === p.failureBands.length - 1 ? band.through !== null : !Number.isSafeInteger(band.through) || Number(band.through) <= previous))
      return fail(400, 'REPORT_POLICY_INVALID', '失败扣分档位不正确。');
    previous = Number(band.through); previousPoints = band.points;
  });
  return p;
}
async function impact(env: ReportEnv, row: Case, outcome: string, reason: string) {
  if (!['upheld','rejected'].includes(outcome)) return fail(400, 'REPORT_DECISION_INVALID', '请选择审核结果。');
  if (row.status !== 'pending') return fail(409, 'REPORT_ALREADY_DECIDED', '该举报已处理。');
  const p = await current(env);
  if (!reason || [...reason].length > p.policy.reviewReasonMaxLength) return fail(400, 'REPORT_REVIEW_REASON_INVALID', '请填写有效的审核原因。');
  const affected = outcome === 'upheld' ? row.target_id : row.reporter_id;
  const score = await env.DB.prepare('SELECT score,revision,updated_at FROM account_reputations WHERE account_id=?')
    .bind(affected).first<{ score: number; revision: number; updated_at: number }>();
  if (!score) return fail(503, 'REPORT_STATE_UNAVAILABLE', '信誉分暂不可用。');
  const now = Math.max(authNow(env), score.updated_at);
  let penalty = p.policy.upheldPenalty;
  if (outcome === 'rejected') {
    const count = await env.DB.prepare(`SELECT count(*) AS n FROM reports WHERE reporter_id=? AND status='rejected'
      AND decided_at>? AND decided_at<=?`).bind(row.reporter_id, now - p.policy.failureWindowSeconds * 1000, now).first<{ n: number }>();
    penalty = p.policy.failureBands.find(b => b.through === null || b.through >= Number(count?.n) + 1)!.points;
  }
  const after = Math.max(Math.min(score.score, p.policy.minimumScore), score.score - penalty);
  const token = await sha256(JSON.stringify([row.id, outcome, reason, p.id, affected, score.revision, score.score, penalty, after]));
  return { policy: p.id, affected, revision: score.revision, before: score.score, after, penalty, now, token,
    affectedLabel: outcome === 'upheld' ? '被举报人' : '举报人', deduction: score.score - after };
}
function cursorOf(url: URL) {
  const cursor = url.searchParams.get('cursor'); if (!cursor) return null;
  try { const v = JSON.parse(atob(cursor)); if (Array.isArray(v) && Number.isSafeInteger(v[0]) && typeof v[1] === 'string' && v[1].length <= 100) return v as [number,string]; } catch {}
  return fail(400, 'REPORT_CURSOR_INVALID', '分页位置无效。');
}
async function listing(env: ReportEnv, account: Account, url: URL, audit: boolean) {
  const p = await current(env); const limit = Math.min(p.policy.maxPageSize, Math.max(1, Math.floor(Number(url.searchParams.get('limit'))) || p.policy.pageSize));
  const cursor = cursorOf(url); const tail = cursor ? ' AND (created_at<? OR (created_at=? AND id<?))' : '';
  const values = cursor ? [cursor[0],cursor[0],cursor[1]] : [];
  let rows: Case[];
  if (audit) {
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending','upheld','rejected'].includes(status)) return fail(400, 'REPORT_STATUS_INVALID', '举报状态不正确。');
    const model = url.searchParams.get('model');
    const operator = model ? await env.DB.prepare('SELECT operator_uid FROM operators WHERE id=?').bind(model).first<{operator_uid:string}>() : null;
    rows = (await env.DB.prepare(`SELECT * FROM reports WHERE status=?${model ? ' AND model_uid=?' : ''}${tail} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .bind(status, ...(model ? [operator?.operator_uid || model] : []), ...values, limit+1).all<Case>()).results;
  } else {
    const branches = await Promise.all([
      env.DB.prepare(`SELECT * FROM reports WHERE reporter_id=?${tail} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(account.id,...values,limit+1).all<Case>(),
      env.DB.prepare(`SELECT * FROM reports WHERE target_id=? AND status='upheld'${tail} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(account.id,...values,limit+1).all<Case>(),
    ]);
    rows = branches.flatMap(r => r.results).sort((a,b) => b.created_at-a.created_at || b.id.localeCompare(a.id));
  }
  const more = rows.length > limit; rows = rows.slice(0,limit); const last = rows.at(-1);
  return reply({ reports: rows.map(r => dto(r,account)), cursor: more && last ? btoa(JSON.stringify([last.created_at,last.id])) : null });
}
async function policyRoute(request: Request, env: ReportEnv, url: URL) {
  const account = await admin(request, env, request.method !== 'GET'); const active = await current(env);
  if (request.method === 'GET') {
    const versions = await env.DB.prepare('SELECT id,previous_id,created_at,created_by,reason FROM report_policy_versions ORDER BY created_at DESC LIMIT 30').all();
    return reply({ ...active, versions: versions.results });
  }
  const data = await body(request); let policy: ReportPolicy;
  if (url.pathname.endsWith('/rollback') || data.version) {
    const v = await env.DB.prepare('SELECT policy FROM report_policy_versions WHERE id=?').bind(text(data.version)).first<{ policy: string }>();
    if (!v) return fail(404, 'REPORT_POLICY_NOT_FOUND', '规则版本不存在。'); policy = validateReportPolicy(JSON.parse(v.policy));
  } else policy = validateReportPolicy(data.policy);
  const reason = text(data.reason);
  const token = await sha256(JSON.stringify([active.id,policy,reason]));
  if (url.pathname.endsWith('/preview')) return reply({ base: active.id, policy, token });
  if (!reason || reason.length > 500) return fail(400, 'REPORT_POLICY_REASON', '请填写规则调整原因。');
  if (data.base !== active.id || data.token !== token) return fail(409, 'REPORT_POLICY_CHANGED', '规则已变化，请重新预览。');
  const id = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO report_policy_versions(id,policy,previous_id,created_by,created_at,reason)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM report_policy_active WHERE singleton=1 AND version_id=?)`)
      .bind(id,JSON.stringify(policy),active.id,account.id,authNow(env),reason,active.id),
    env.DB.prepare(`UPDATE report_policy_active SET version_id=?,revision=revision+1 WHERE singleton=1 AND version_id=?
      AND EXISTS(SELECT 1 FROM report_policy_versions WHERE id=?)`).bind(id,active.id,id),
  ]);
  if (!results[1].meta.changes) return fail(409, 'REPORT_POLICY_CHANGED', '规则已变化，请重新预览。');
  return reply(await current(env));
}
export async function reportRoute(request: Request, env: ReportEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const legacy = path.match(/^\/api\/threads\/([^/]+)\/report$/);
  if (!(path === '/api/reputation' || path === '/api/reports' || path.startsWith('/api/reports/') ||
    path === '/api/admin/reports' || path.startsWith('/api/admin/reports/') || path.startsWith('/api/admin/report-policy') || legacy)) return null;
  if (path.startsWith('/api/admin/report-policy')) {
    if (method === 'GET' && path === '/api/admin/report-policy' || method === 'POST' && /^\/api\/admin\/report-policy\/(preview|publish|rollback)$/.test(path))
      return policyRoute(request,env,url);
    return fail(405, 'METHOD_NOT_ALLOWED', '不支持此操作。');
  }
  const account = await requireAccount(request,env);
  if (path === '/api/reputation' && method === 'GET') {
    const score = await env.DB.prepare('SELECT score,initial_score AS initialScore,deducted,event_count AS eventCount,revision,report_revision AS reportRevision,updated_at AS updatedAt FROM account_reputations WHERE account_id=?')
      .bind(account.id).first();
    if (!score) return fail(503,'REPORT_STATE_UNAVAILABLE','信誉分暂不可用，请稍后重试。');
    const p = await current(env); return reply({ ...score, minimumReportScore: p.policy.minimumReportScore });
  }
  if (path === '/api/reports' && method === 'POST' || legacy && method === 'POST') return create(request,env,account,await body(request),legacy?.[1]);
  if (path === '/api/reports' && method === 'GET') {
    const key = url.searchParams.get('requestKey');
    if (key) {
      const row = await env.DB.prepare('SELECT * FROM reports WHERE reporter_id=? AND request_key=?').bind(account.id,key).first<Case>();
      return reply({ report: row ? await details(env,row,account) : null });
    }
    return listing(env,account,url,false);
  }
  if (path === '/api/reports/states' && method === 'POST') {
    const data = await body(request);
    if (!Array.isArray(data.messageIds) || data.messageIds.length > 50 || data.messageIds.some(id => typeof id !== 'string' || id.length>100)) return fail(400,'REPORT_MESSAGE_IDS','消息列表不正确。');
    const ids = [...new Set(data.messageIds as string[])]; if (!ids.length) return reply({ states: [] });
    const p = await current(env);
    // At most 50 sources; pair state is one bounded query for the distinct visible targets.
    const sources = (await env.DB.prepare(`${sourceSQL} WHERE m.id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all<Source>()).results;
    const targets = [...new Set(sources.filter(s=>sourceRole(s,account)).map(s=>s.author_account_id!))];
    const pairs = targets.length ? (await env.DB.prepare(`SELECT p.target_id,
      CASE WHEN p.locked_at>0 OR p.success_count>=p.success_limit THEN 1 ELSE 0 END AS locked, p.success_limit-p.success_count AS remaining,
      (SELECT count(*) FROM reports r WHERE r.reporter_id=p.reporter_id AND r.target_id=p.target_id AND r.status='pending') AS pendingCount,
      (SELECT id FROM reports r WHERE r.reporter_id=p.reporter_id AND r.target_id=p.target_id AND r.status='pending' ORDER BY created_at DESC,id DESC LIMIT 1) AS pending
      FROM report_pairs p WHERE p.reporter_id=? AND p.target_id IN (${targets.map(()=>'?').join(',')})`)
      .bind(account.id,...targets).all<{target_id:string;locked:number;pending:string|null;pendingCount:number;remaining:number}>()).results : [];
    const reputation = await env.DB.prepare('SELECT score FROM account_reputations WHERE account_id=?').bind(account.id).first<{score:number}>();
    if (!reputation) return fail(503,'REPORT_STATE_UNAVAILABLE','举报暂时不可用，请稍后重试。');
    return reply({ limits: {reasonMinLength:p.policy.reasonMinLength,reasonMaxLength:p.policy.reasonMaxLength,minimumReportScore:p.policy.minimumReportScore}, states: ids.map(id=> {
      const source=sources.find(s=>s.id===id); if(!source || !sourceRole(source,account)) return {id,state:'unavailable'};
      const pair=pairs.find(p=>p.target_id===source.author_account_id);
      return {id,state:pair?.locked?'locked':pair && pair.pendingCount>=Math.min(p.policy.pendingPerPair,pair.remaining)?'pending':Number(reputation?.score)<p.policy.minimumReportScore?'restricted':'available',reportId:pair?.pending || null};
    }) });
  }
  if (path === '/api/admin/reports' && method === 'GET') { assertAdmin(account,env); return listing(env,account,url,true); }
  const review = path.match(/^\/api\/admin\/reports\/([^/]+)\/(preview|decision)$/);
  if (review && method === 'POST') {
    assertAdmin(account,env); const data = await body(request); const row = await find(env,review[1]);
    const outcome = text(data.outcome), reason = text(data.reason);
    if (row.status !== 'pending' && review[2] === 'decision') {
      if (row.status !== outcome) return fail(409,'REPORT_ALREADY_DECIDED','该举报已处理。');
      return reply({ report: await details(env,row,account), replayed: true });
    }
    const calculated = await impact(env,row,outcome,reason);
    if (review[2] === 'preview') return reply(calculated);
    if (data.token !== calculated.token) return fail(409,'REPORT_IMPACT_CHANGED','扣分结果已变化，请重新确认。');
    try {
      const result = await env.DB.prepare(`UPDATE reports SET status=?,reviewer_id=?,review_reason=?,decided_at=?,decision_policy_id=?,
        affected_id=?,nominal_penalty=?,score_before=?,score_after=?,score_revision=? WHERE id=? AND status='pending'`)
        .bind(outcome,account.id,reason,calculated.now,calculated.policy,calculated.affected,calculated.penalty,
          calculated.before,calculated.after,calculated.revision,row.id).run();
      if (!result.meta.changes) return fail(409,'REPORT_ALREADY_DECIDED','该举报已处理。');
    } catch (error) {
      const recovered = await find(env,row.id).catch(()=>null);
      if (recovered?.status === outcome) return reply({ report: await details(env,recovered,account), replayed:true });
      databaseError(error);
    }
    return reply({ report: await details(env,await find(env,row.id),account) });
  }
  const image = path.match(/^\/api\/reports\/([^/]+)\/images\/([^/]+)$/);
  if (image && method === 'GET') {
    const row = await find(env,image[1]); if (!mayRead(row,account)) return fail(404,'REPORT_NOT_FOUND','举报记录不存在。');
    const asset = await env.DB.prepare('SELECT image_key,image_type FROM report_images WHERE report_id=? AND image_id=?')
      .bind(row.id,image[2]).first<{image_key:string;image_type:string}>();
    if (!asset) return fail(404,'REPORT_IMAGE_NOT_FOUND','图片不存在。');
    const data = await env.IMAGES.get(asset.image_key,'arrayBuffer'); if (!data) return fail(404,'REPORT_IMAGE_NOT_FOUND','图片不存在。');
    return new Response(data,{headers:{'content-type':asset.image_type,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }
  const detail = path.match(/^\/api\/reports\/([^/]+)$/);
  if (detail && method === 'GET') return reply({ report: await details(env,await find(env,detail[1]),account) });
  return fail(405,'METHOD_NOT_ALLOWED','不支持此操作。');
}
