import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { nativeFeatureAllowed, type NativeFeature } from './group-config.js';
import type { ConversationMessage } from './ai.js';
import type { Group, Persona, Plugin, Proposal, Role, Task } from '../shared.js';

type StoredGroup = Omit<Group, 'role'>;
type Row = Record<string, unknown>;
export const STORAGE_SCHEMA_VERSION = 4;
const APPLICATION_ID = 0x47575031;
const TABLES = ['groups', 'plugins', 'actors', 'memberships', 'private_scopes', 'proposals', 'tasks', 'telegram_deliveries', 'audit_log', 'conversations'] as const;
const COLUMNS: Record<(typeof TABLES)[number], string[]> = {
  conversations: ['group_id', 'actor_id', 'json'],
  groups: ['id', 'version', 'json', 'scope', 'telegram_chat_id'],
  plugins: ['id', 'json'], actors: ['id', 'telegram_user_id', 'json'],
  memberships: ['group_id', 'actor_id', 'role', 'verified_at'],
  private_scopes: ['id', 'actor_id', 'version', 'json'],
  proposals: ['id', 'group_id', 'creator_id', 'json'],
  tasks: ['id', 'group_id', 'creator_id', 'audience', 'request_key', 'request_hash', 'draft_json', 'result_json', 'expired'],
  telegram_deliveries: ['task_id', 'group_id', 'actor_id', 'status', 'updated_at'],
  audit_log: ['id', 'actor_id', 'group_id', 'action', 'target_id', 'outcome', 'created_at'],
};
// These are local preview identities, never Telegram identities or production grants.
export const PERSONAS: readonly Persona[] = [
  { id: 'admin-a', name: '林舟', label: '设计群管理员', platformAdmin: false },
  { id: 'admin-b', name: '许夏', label: '阅读群管理员', platformAdmin: false },
  { id: 'member', name: '陈小满', label: '两群普通成员', platformAdmin: false },
  { id: 'platform', name: '平台管理员', label: '本地平台管理', platformAdmin: true },
];

const MEMBERSHIPS: Record<string, Record<string, Role>> = {
  'admin-a': { 'group-a': 'admin' },
  'admin-b': { 'group-b': 'admin' },
  member: { 'group-a': 'member', 'group-b': 'member' },
  // Platform maintenance never implies group membership or group administration.
  // Any future group grant must be independently verified and bound as admin/member.
  platform: {},
};

const INITIAL_PLUGINS: Plugin[] = [
  { id: 'link-cleaner', name: '链接整理', description: '用固定代码提取、去重、排序和限制链接条数。', kind: 'code', enabled: true, available: true, scope: '只处理本次输入，不访问链接', color: 'blue' },
  { id: 'digest', name: '智能摘要', description: '默认关闭的 DSH Skill 摘要，只把本次明确输入发送给 DeepSeek，不读取群历史。', kind: 'agent', enabled: false, available: false, scope: '只处理明确输入；需要真实模型绑定', color: 'violet' },
  { id: 'echo', name: '原生文本回显', description: '直接运行 Koishi 官方 Echo 插件，返回本次文本。', kind: 'code', enabled: true, available: false, scope: '只返回本次输入；不指定其他群或用户', color: 'green' },
  { id: 'link-brief', name: '链接整理与说明', description: 'AI 调用 Koishi 链接插件，再根据代码结果与本次原文生成说明。', kind: 'agent', enabled: false, available: false, scope: '本次输入与整理结果；需要本群开放链接整理和专用模型绑定', color: 'violet' },
  { id: 'welcome', name: '新成员欢迎', description: 'Koishi 文本插件按本群模板欢迎新成员，群内事件由当前机器人处理。', kind: 'code', enabled: false, available: false, scope: '仅当前群加入事件和显示名，不读取历史；模板为普通文本', color: 'green' },
  { id: 'antiad', name: '反广告检测', description: '复用 antiad 判定核心，检测本次明确提交的文本；尚不自动删帖或封禁。', kind: 'code', enabled: false, available: false, scope: '需要平台批准的只读模型，不接入旧数据库或跨群训练反馈', color: 'amber' },
  { id: 'assistant', name: '群助手', description: '按本次明确目标回答，可按本群权限选择调用链接整理代码；默认关闭。', kind: 'agent', enabled: false, available: false, scope: '每次确认文本处理；不读取群历史，不发送消息或修改群权限', color: 'violet' },
  { id: 'reminder', name: '提醒', description: '提醒能力的产品占位，尚无调度或执行入口。', kind: 'code', enabled: false, available: false, scope: '未接入', color: 'amber' },
];

const INITIAL_GROUPS: StoredGroup[] = [
  { id: 'group-a', name: '设计共创', description: '共享设计灵感，把群里的链接整理成清晰列表。', initials: '设', memberCount: 2, version: 1, config: { responseMode: 'mention', language: 'zh', features: ['link-cleaner'], deduplicate: true, sort: false, maxItems: 20 } },
  { id: 'group-b', name: '周末阅读', description: '收集文章与阅读资料，每个群拥有自己的配置。', initials: '读', memberCount: 2, version: 1, config: { responseMode: 'command', language: 'zh', features: ['link-cleaner'], deduplicate: true, sort: true, maxItems: 10 } },
];

function decode<T>(row: Row | undefined, column = 'json'): T | undefined {
  return row && typeof row[column] === 'string' ? JSON.parse(row[column] as string) as T : undefined;
}
export class StoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'StoreError'; }
}
function requireId(value: string | number, negative: boolean): string {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (negative ? number >= 0 : number <= 0) || String(number) !== String(value)) {
    throw new StoreError('INVALID_TELEGRAM_ID', 'Telegram 标识必须为指定符号的规范安全整数。');
  }
  return String(number);
}
export function telegramGroupId(chatId: string | number): string { return `tg:${requireId(chatId, true)}`; }
export function telegramActorId(userId: string | number): string { return `tg-user:${requireId(userId, false)}`; }
export function telegramPrivateId(userId: string | number): string { return `tg-dm:${requireId(userId, false)}`; }
function profileName(name: string | undefined, fallback: string): string { return name?.trim().slice(0, 80) || fallback; }

export interface TaskReservation {
  task?: Task; pending: boolean; expired?: boolean; requestHash: string;
  groupId: string; creatorId: string; audience: Task['audience'];
  featureId: Task['featureId']; authorization?: Task['authorization'];
}
export interface RetentionLimits {
  tasksPerGroup: number; proposalsPerGroup: number; auditMax: number;
  idempotencyMax: number; deliveryMax: number; maxPages: number;
  backupsMax: number; backupBytesMax: number;
}
export interface StoreOptions { retention?: Partial<RetentionLimits> }
export interface BackupReport { path: string; pages: number; schemaVersion: number; integrity: 'ok'; sha256: string }
export interface AuditInput { actorId: string; groupId?: string; action: string; targetId?: string; outcome: string }
export interface AuditRecord extends AuditInput { id: number; createdAt: string }
const DEFAULT_RETENTION: RetentionLimits = {
  tasksPerGroup: 100, proposalsPerGroup: 50, auditMax: 1000,
  idempotencyMax: 10_000, deliveryMax: 10_000, maxPages: 32_768,
  backupsMax: 5, backupBytesMax: 256 * 1024 * 1024,
};
// Closed event vocabulary: audit records must not become an arbitrary text/error sink.
const AUDIT_ACTIONS = new Set(['auth.login', 'group.register', 'group.migrate', 'member.sync', 'rules.preview', 'rules.activate',
  'proposal.create', 'proposal.activate', 'task.reserve', 'task.finish', 'task.execute', 'task.cancel',
  'plugin.toggle', 'plugin.maintenance', 'authorization.check', 'access.check', 'storage.prune', 'storage.backup', 'storage.restore',
  'maintenance.prune', 'maintenance.backup', 'delivery.claim', 'delivery.sent', 'delivery.unknown', 'delivery.withheld']);
const AUDIT_OUTCOMES = new Set(['allowed', 'denied', 'succeeded', 'failed', 'blocked', 'expired', 'sent', 'unknown', 'withheld',
  'verified', 'registered', 'pending', 'active', 'requested', 'enabled', 'disabled', 'completed', 'removed', 'admin', 'member']);
function integerPragma(db: DatabaseSync, name: string): number {
  return Number((db.prepare(`PRAGMA ${name}`).get() as Row)[name]);
}
function verifyDatabase(db: DatabaseSync): { pages: number; schemaVersion: number; integrity: 'ok' } {
  const integrity = db.prepare('PRAGMA integrity_check').all() as Row[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new StoreError('BACKUP_INVALID', 'SQLite 完整性检查未通过。');
  if (integerPragma(db, 'application_id') !== APPLICATION_ID || integerPragma(db, 'user_version') !== STORAGE_SCHEMA_VERSION) {
    throw new StoreError('BACKUP_SCHEMA', '备份的应用标识或 schema 版本不兼容。');
  }
  const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Row[]).map(row => row.name as string).sort();
  if (JSON.stringify(names) !== JSON.stringify([...TABLES].sort())) throw new StoreError('BACKUP_SCHEMA', '备份表结构不兼容。');
  for (const table of TABLES) {
    const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => row.name);
    if (JSON.stringify(names) !== JSON.stringify(COLUMNS[table])) throw new StoreError('BACKUP_SCHEMA', '备份列结构不兼容。');
  }
  if ((db.prepare('PRAGMA foreign_key_check').all() as Row[]).length) throw new StoreError('BACKUP_INVALID', '备份关系完整性检查未通过。');
  for (const [table, column] of [['groups', 'json'], ['plugins', 'json'], ['actors', 'json'], ['private_scopes', 'json'], ['proposals', 'json'], ['tasks', 'draft_json'], ['tasks', 'result_json'], ['conversations', 'json']] as const) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL AND NOT json_valid(${column}) LIMIT 1`).get()) throw new StoreError('BACKUP_INVALID', '备份记录不是有效 JSON。');
  }
  for (const sql of [
    "SELECT 1 FROM groups WHERE json_extract(json,'$.id') IS NOT id OR json_extract(json,'$.version') IS NOT version OR (scope='preview' AND id NOT IN ('group-a','group-b')) OR (scope='telegram' AND id IS NOT 'tg:'||telegram_chat_id) LIMIT 1",
    "SELECT 1 FROM actors WHERE json_extract(json,'$.id') IS NOT id OR id IS NOT 'tg-user:'||telegram_user_id OR json_extract(json,'$.platformAdmin') IS NOT 0 LIMIT 1",
    "SELECT 1 FROM private_scopes WHERE id IS NOT 'tg-dm:'||substr(actor_id,9) OR actor_id NOT IN (SELECT id FROM actors) OR json_extract(json,'$.id') IS NOT id OR json_extract(json,'$.version') IS NOT version OR json_extract(json,'$.actorId') IS NOT actor_id LIMIT 1",
    "SELECT 1 FROM proposals WHERE json_extract(json,'$.id') IS NOT id OR json_extract(json,'$.groupId') IS NOT group_id OR json_extract(json,'$.creatorId') IS NOT creator_id LIMIT 1",
    "SELECT 1 FROM tasks WHERE (expired=1 AND (draft_json IS NOT '{}' OR result_json IS NOT NULL)) OR (expired=0 AND (json_extract(draft_json,'$.id') IS NOT id OR json_extract(draft_json,'$.groupId') IS NOT group_id OR json_extract(draft_json,'$.creatorId') IS NOT creator_id OR json_extract(draft_json,'$.audience') IS NOT audience)) OR (result_json IS NOT NULL AND (json_extract(result_json,'$.id') IS NOT id OR json_extract(result_json,'$.groupId') IS NOT group_id OR json_extract(result_json,'$.creatorId') IS NOT creator_id OR json_extract(result_json,'$.audience') IS NOT audience)) LIMIT 1",
  ]) if (db.prepare(sql).get()) throw new StoreError('BACKUP_INVALID', '备份记录的索引与对象归属不一致。');
  return { pages: integerPragma(db, 'page_count'), schemaVersion: STORAGE_SCHEMA_VERSION, integrity: 'ok' };
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function migrateDatabase(db: DatabaseSync): void {
    const version = integerPragma(db, 'user_version');
    const identity = integerPragma(db, 'application_id');
    if (version > STORAGE_SCHEMA_VERSION || (identity !== 0 && identity !== APPLICATION_ID) || (version > 0 && identity !== APPLICATION_ID)) throw new StoreError('SCHEMA_UNSUPPORTED', '数据库版本或应用标识不兼容，未修改。');
    if (version === 0) {
      const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Row[]).map(row => String(row.name));
      if (tables.some(name => !['groups', 'plugins', 'proposals', 'tasks'].includes(name))) throw new StoreError('SCHEMA_UNSUPPORTED', '非 GroupWeave 旧版数据库，未修改。');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (version < 1) db.exec(`
        CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,version INTEGER NOT NULL,json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,creator_id TEXT NOT NULL,json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,creator_id TEXT NOT NULL,audience TEXT NOT NULL,
          request_key TEXT,request_hash TEXT NOT NULL,draft_json TEXT NOT NULL,result_json TEXT,UNIQUE(group_id,creator_id,request_key));
        CREATE INDEX IF NOT EXISTS tasks_group ON tasks(group_id);
      `);
      if (version < 2) db.exec(`
        ALTER TABLE groups ADD COLUMN scope TEXT NOT NULL DEFAULT 'preview' CHECK(scope IN ('preview','telegram'));
        ALTER TABLE groups ADD COLUMN telegram_chat_id TEXT;
        CREATE UNIQUE INDEX groups_telegram_chat ON groups(telegram_chat_id);
        ALTER TABLE tasks ADD COLUMN expired INTEGER NOT NULL DEFAULT 0 CHECK(expired IN (0,1));
        CREATE TABLE actors(id TEXT PRIMARY KEY,telegram_user_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL);
        CREATE TABLE memberships(group_id TEXT NOT NULL REFERENCES groups(id) ON UPDATE CASCADE ON DELETE CASCADE,
          actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('admin','member')),
          verified_at TEXT NOT NULL,PRIMARY KEY(group_id,actor_id));
        CREATE TABLE telegram_deliveries(task_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,actor_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('claimed','sent','unknown','withheld')),updated_at TEXT NOT NULL);
        CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,group_id TEXT,
          action TEXT NOT NULL,target_id TEXT,outcome TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX audit_group ON audit_log(group_id,id);
      `);
      if (version < 3) db.exec(`CREATE TABLE private_scopes(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id) ON DELETE CASCADE,version INTEGER NOT NULL,json TEXT NOT NULL);`);
      if (version < 4) db.exec(`CREATE TABLE conversations(group_id TEXT NOT NULL,actor_id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(group_id,actor_id));`);
      db.exec(`PRAGMA user_version=${STORAGE_SCHEMA_VERSION}; PRAGMA application_id=${APPLICATION_ID};`);
      verifyDatabase(db);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

export class Store {
  private readonly db: DatabaseSync;
  private readonly filename: string;
  private readonly backupDirectory?: string;
  private readonly retention: RetentionLimits;
  private backupOperation?: Promise<BackupReport>;
  readonly schemaVersion = STORAGE_SCHEMA_VERSION;

  constructor(dataDir?: string, options: StoreOptions = {}) {
    this.retention = { ...DEFAULT_RETENTION, ...options.retention };
    for (const limit of Object.values(this.retention)) if (!Number.isSafeInteger(limit) || limit < 1) throw new StoreError('INVALID_RETENTION', '保留上限必须为正安全整数。');
    if (dataDir) { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700); }
    this.filename = dataDir ? resolve(dataDir, 'groupweave.sqlite') : ':memory:';
    this.backupDirectory = dataDir ? resolve(dataDir, 'backups') : undefined;
    this.db = new DatabaseSync(this.filename);
    try {
      // The native lock is acquired before migration, seeding, or recovery.
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA foreign_keys=ON;');
    migrateDatabase(this.db);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA max_page_count=${this.retention.maxPages};`);
      const groupInsert = this.db.prepare("INSERT OR IGNORE INTO groups(id,version,json,scope) VALUES(?,?,?,'preview')");
      for (const group of INITIAL_GROUPS) groupInsert.run(group.id, group.version, JSON.stringify(group));
      const pluginInsert = this.db.prepare('INSERT OR IGNORE INTO plugins(id,json) VALUES(?,?)');
      for (const plugin of INITIAL_PLUGINS) pluginInsert.run(plugin.id, JSON.stringify(plugin));
      this.recover(); this.prune();
      if (this.filename !== ':memory:') chmodSync(this.filename, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private recover(): void {
    this.db.exec(`UPDATE tasks SET result_json=json_set(draft_json,'$.status','blocked','$.output','','$.error','服务重启中断；先前执行结果未知，未自动重放。') WHERE result_json IS NULL AND expired=0;
      UPDATE telegram_deliveries SET status='unknown' WHERE status='claimed';`);
  }
  close(): void {
    if (this.backupOperation) throw new StoreError('BACKUP_RUNNING', '备份进行中，待其完成后再关闭数据库。');
    this.db.close();
  }
  async waitForMaintenance(): Promise<void> {
    // Drain only. The request initiating backup remains responsible for its error.
    await this.backupOperation?.then(() => undefined, () => undefined);
  }
  persona(id: string): Persona | undefined {
    const preview = PERSONAS.find(persona => persona.id === id);
    if (preview) return { ...preview };
    if (!id.startsWith('tg-user:')) return undefined;
    const actor = decode<Persona>(this.db.prepare('SELECT json FROM actors WHERE id=?').get(id) as Row | undefined);
    return actor ? { ...actor, id, platformAdmin: false } : undefined;
  }
  role(actorId: string, groupId: string): Role | undefined {
    if (groupId.startsWith('tg-dm:')) {
      const owner = this.db.prepare('SELECT actor_id FROM private_scopes WHERE id=?').get(groupId) as Row | undefined;
      return owner?.actor_id === actorId ? 'admin' : undefined;
    }
    const row = this.db.prepare('SELECT scope FROM groups WHERE id=?').get(groupId) as Row | undefined;
    if (row?.scope === 'preview') return MEMBERSHIPS[actorId]?.[groupId];
    if (row?.scope !== 'telegram' || !actorId.startsWith('tg-user:')) return undefined;
    return (this.db.prepare('SELECT role FROM memberships WHERE group_id=? AND actor_id=?').get(groupId, actorId) as Row | undefined)?.role as Role | undefined;
  }
  group(groupId: string, actorId: string): Group | undefined {
    const role = this.role(actorId, groupId);
    if (!role) return undefined;
    const isPrivate = groupId.startsWith('tg-dm:');
    const stored = decode<StoredGroup>(this.db.prepare(isPrivate ? 'SELECT json FROM private_scopes WHERE id=?' : 'SELECT json FROM groups WHERE id=?').get(groupId) as Row | undefined);
    if (!stored) return undefined;
    const memberCount = groupId.startsWith('tg:') ? Number((this.db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE group_id=?').get(groupId) as Row).count) : isPrivate ? 1 : stored.memberCount;
    return { ...stored, memberCount, role };
  }
  groups(actorId: string): Group[] {
    const ids = actorId.startsWith('tg-user:') ? (this.db.prepare('SELECT group_id FROM memberships WHERE actor_id=? ORDER BY group_id').all(actorId) as Row[]).map(row => row.group_id as string) : Object.keys(MEMBERSHIPS[actorId] ?? {});
    return ids.flatMap(id => { const group = this.group(id, actorId); return group ? [group] : []; });
  }
  upsertTelegramActor(userId: string | number, name?: string): string {
    const actorId = telegramActorId(userId);
    const previous = this.persona(actorId);
    const persona: Persona = { id: actorId, name: profileName(name, previous?.name || actorId), label: 'Telegram 用户', platformAdmin: false };
    this.db.prepare('INSERT INTO actors(id,telegram_user_id,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(actorId, requireId(userId, false), JSON.stringify(persona));
    return actorId;
  }
  ensureTelegramPrivate(userId: string | number, name?: string): { groupId: string; actorId: string; created: boolean } {
    const actorId = this.upsertTelegramActor(userId, name);
    const groupId = telegramPrivateId(userId);
    const displayName = profileName(name, this.persona(actorId)?.name || actorId);
    const config: StoredGroup = { id: groupId, name: displayName, description: 'Telegram 私聊配置', initials: [...displayName][0] || '私', memberCount: 1, version: 1,
      config: { responseMode: 'command', language: 'zh', features: ['assistant', 'digest'], deduplicate: true, sort: false, maxItems: 20 } };
    const result = this.db.prepare('INSERT OR IGNORE INTO private_scopes(id,actor_id,version,json) VALUES(?,?,1,?)').run(groupId, actorId, JSON.stringify({ ...config, actorId }));
    return { groupId, actorId, created: result.changes === 1 };
  }
  registerTelegramGroup(input: { chatId: string | number; title: string; userId: string | number; name?: string }): { groupId: string; actorId: string; created: boolean } {
    const groupId = telegramGroupId(input.chatId);
    const actorId = this.upsertTelegramActor(input.userId, input.name);
    const name = profileName(input.title, groupId);
    const group: StoredGroup = { id: groupId, name, description: 'Telegram 群配置', initials: [...name][0] || '群', memberCount: 0, version: 1,
      config: { responseMode: 'command', language: 'zh', features: ['link-cleaner'], deduplicate: true, sort: false, maxItems: 20 } };
    const result = this.db.prepare("INSERT OR IGNORE INTO groups(id,version,json,scope,telegram_chat_id) VALUES(?,?,?,'telegram',?)").run(groupId, 1, JSON.stringify(group), requireId(input.chatId, true));
    // Registration is not membership: only a fresh trusted Telegram observation grants a cached role.
    if (result.changes) this.audit({ actorId, groupId, action: 'group.register', outcome: 'registered' });
    return { groupId, actorId, created: result.changes === 1 };
  }
  syncTelegramMember(chatId: string | number, userId: string | number, role: Role | undefined, displayName?: string): void {
    const groupId = telegramGroupId(chatId);
    if (!this.db.prepare("SELECT id FROM groups WHERE id=? AND scope='telegram'").get(groupId)) throw new StoreError('GROUP_UNREGISTERED', 'Telegram 群尚未登记。');
    if (role !== undefined && role !== 'admin' && role !== 'member') throw new StoreError('INVALID_ROLE', '群角色只能为 admin 或 member。');
    const actorId = this.upsertTelegramActor(userId, displayName);
    if (role === undefined) this.db.prepare('DELETE FROM memberships WHERE group_id=? AND actor_id=?').run(groupId, actorId);
    else this.db.prepare('INSERT INTO memberships(group_id,actor_id,role,verified_at) VALUES(?,?,?,?) ON CONFLICT(group_id,actor_id) DO UPDATE SET role=excluded.role,verified_at=excluded.verified_at').run(groupId, actorId, role, new Date().toISOString());
    this.audit({ actorId, groupId, action: 'member.sync', outcome: role ?? 'removed' });
  }
  migrateTelegramGroup(oldChatId: string | number, newChatId: string | number): void {
    const oldId = telegramGroupId(oldChatId), newId = telegramGroupId(newChatId);
    if (oldId === newId) throw new StoreError('MIGRATION_CONFLICT', '群迁移目标必须不同。');
    this.transaction(() => {
      const row = this.db.prepare("SELECT json FROM groups WHERE id=? AND scope='telegram'").get(oldId) as Row | undefined;
      if (!row || this.db.prepare('SELECT id FROM groups WHERE id=?').get(newId)) throw new StoreError('MIGRATION_CONFLICT', '群迁移来源不存在或目标已存在；未合并群。');
      const group = decode<StoredGroup>(row)!;
      this.db.prepare('UPDATE groups SET id=?,telegram_chat_id=?,json=? WHERE id=?').run(newId, requireId(newChatId, true), JSON.stringify({ ...group, id: newId }), oldId);
      for (const row of this.db.prepare('SELECT id,json FROM proposals WHERE group_id=?').all(oldId) as Row[]) {
        const proposal = decode<Proposal>(row)!;
        this.db.prepare('UPDATE proposals SET group_id=?,json=? WHERE id=?').run(newId, JSON.stringify({ ...proposal, groupId: newId }), row.id as string);
      }
      for (const row of this.db.prepare('SELECT * FROM tasks WHERE group_id=?').all(oldId) as Row[]) {
        const draft = row.expired ? undefined : decode<Task>(row, 'draft_json');
        let result = row.expired ? undefined : decode<Task>(row, 'result_json');
        if (draft && !result) result = { ...draft, status: 'blocked', output: '', error: '群已迁移；先前执行结果未知，未自动重放或投递。' };
        this.db.prepare('UPDATE tasks SET group_id=?,draft_json=?,result_json=? WHERE id=?').run(newId,
          draft ? JSON.stringify({ ...draft, groupId: newId }) : '{}', result ? JSON.stringify({ ...result, groupId: newId }) : null, row.id as string);
      }
      this.db.prepare("UPDATE telegram_deliveries SET group_id=?,status=CASE WHEN status='claimed' THEN 'unknown' ELSE status END WHERE group_id=?").run(newId, oldId);
      this.db.prepare('UPDATE audit_log SET group_id=? WHERE group_id=?').run(newId, oldId);
      this.db.prepare('UPDATE conversations SET group_id=? WHERE group_id=?').run(newId, oldId);
    });
    this.audit({ actorId: 'system', groupId: newId, action: 'group.migrate', outcome: 'completed' });
  }
  plugins(): Plugin[] { return (this.db.prepare('SELECT json FROM plugins ORDER BY rowid').all() as Row[]).map(row => decode<Plugin>(row)!); }
  plugin(id: string): Plugin | undefined { return decode<Plugin>(this.db.prepare('SELECT json FROM plugins WHERE id=?').get(id) as Row | undefined); }
  setPluginEnabled(id: string, enabled: boolean): Plugin | undefined {
    const plugin = this.plugin(id); if (!plugin) return undefined;
    const updated = { ...plugin, enabled, authorizationVersion: (plugin.authorizationVersion ?? 0) + Number(plugin.enabled !== enabled) };
    this.db.prepare('UPDATE plugins SET json=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  }
  setPluginAvailability(id: string, available: boolean): Plugin | undefined {
    // Trusted startup capability observation only. No HTTP endpoint may call this
    // from client metadata, and availability never turns on the global switch.
    const plugin = this.plugin(id); if (!plugin) return undefined;
    const seed = INITIAL_PLUGINS.find(value => value.id === id);
    const updated = { ...plugin, available, authorizationVersion: (plugin.authorizationVersion ?? 0) + Number(plugin.available !== available), ...(seed ? { description: seed.description, scope: seed.scope } : {}) };
    this.db.prepare('UPDATE plugins SET json=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  }
  permissionVersions(groupId: string, featureId: string) {
    const group = decode<StoredGroup>((this.db.prepare(groupId.startsWith('tg-dm:') ? 'SELECT json FROM private_scopes WHERE id=?' : 'SELECT json FROM groups WHERE id=?').get(groupId) as Row | undefined));
    const plugin = this.plugin(featureId);
    if (!group || !plugin) throw new StoreError('CAPABILITY_SCOPE', '功能归属不存在。');
    return { platformVersion: plugin.authorizationVersion ?? 0, groupVersion: group.featureVersions?.[featureId] ?? 0 };
  }
  /** Synchronous final check: a disable/enable cycle cannot revive a pending delivery. */
  taskAuthorized(task: Task): boolean {
    const group = this.group(task.groupId, task.creatorId), plugin = this.plugin(task.featureId), snapshot = task.authorization;
    if (!group || !plugin?.enabled || !plugin.available || !group.config.features.includes(task.featureId) || !snapshot) return false;
    const current = this.permissionVersions(task.groupId, task.featureId);
    if (current.platformVersion !== snapshot.platformVersion || current.groupVersion !== snapshot.groupVersion) return false;
    if (task.featureId === 'link-brief' || (task.featureId === 'assistant' && task.toolCalls === 1)) {
      const code = this.plugin('link-cleaner'), versions = this.permissionVersions(task.groupId, 'link-cleaner');
      if (!group.config.features.includes('link-cleaner') || !code?.enabled || !code.available
        || versions.platformVersion !== snapshot.codePlatformVersion || versions.groupVersion !== snapshot.codeGroupVersion) return false;
    }
    return true;
  }
  putProposal(proposal: Proposal): void {
    this.db.prepare('INSERT INTO proposals(id,group_id,creator_id,json) VALUES(?,?,?,?)').run(proposal.id, proposal.groupId, proposal.creatorId, JSON.stringify(proposal)); this.prune();
  }
  cancelProposal(id: string, actorId: string): Proposal | undefined {
    const proposal = this.proposal(id);
    if (!proposal || proposal.creatorId !== actorId || this.role(actorId, proposal.groupId) !== 'admin' || proposal.status !== 'pending') return undefined;
    const cancelled: Proposal = { ...proposal, status: 'cancelled' };
    this.db.prepare('UPDATE proposals SET json=? WHERE id=?').run(JSON.stringify(cancelled), id);
    return cancelled;
  }
  proposal(id: string): Proposal | undefined { return decode<Proposal>(this.db.prepare('SELECT json FROM proposals WHERE id=?').get(id) as Row | undefined); }
  activateProposal(id: string, actorId: string): { proposal: Proposal; conflict: boolean } | undefined {
    return this.transaction(() => {
      const proposal = this.proposal(id); if (!proposal || proposal.creatorId !== actorId || proposal.status === 'cancelled' || this.role(actorId, proposal.groupId) !== 'admin') return undefined;
      if (proposal.status === 'active') return { proposal, conflict: false };
      const group = this.group(proposal.groupId, actorId)!;
      if (group.version !== proposal.baseVersion) return { proposal, conflict: true };
      const { role: _role, ...stored } = group;
      const featureVersions = { ...group.featureVersions };
      for (const id of new Set([...group.config.features, ...proposal.candidate.features])) {
        if (group.config.features.includes(id) !== proposal.candidate.features.includes(id)) featureVersions[id] = (featureVersions[id] ?? 0) + 1;
      }
      const updated: StoredGroup = { ...stored, featureVersions, version: group.version + 1, config: proposal.candidate };
      const result = this.db.prepare('UPDATE groups SET version=?,json=? WHERE id=? AND version=?').run(updated.version, JSON.stringify(updated), group.id, proposal.baseVersion);
      if (result.changes !== 1) return { proposal, conflict: true };
      const active: Proposal = { ...proposal, status: 'active' };
      this.db.prepare('UPDATE proposals SET json=? WHERE id=?').run(JSON.stringify(active), id);
      return { proposal: active, conflict: false };
    });
  }
  reservation(groupId: string, creatorId: string, key: string): TaskReservation | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE group_id=? AND creator_id=? AND request_key=?').get(groupId, creatorId, key) as Row | undefined;
    return row ? this.taskRecord(row) : undefined;
  }
  private taskRecord(row: Row): TaskReservation {
    const expired = row.expired === 1;
    const saved = decode<Task>(row, 'result_json') ?? decode<Task>(row, 'draft_json');
    return { task: expired ? undefined : decode<Task>(row, 'result_json'), pending: !expired && row.result_json === null, expired,
      requestHash: row.request_hash as string, groupId: row.group_id as string, creatorId: row.creator_id as string,
      audience: row.audience as Task['audience'], featureId: saved?.featureId ?? '', authorization: saved?.authorization };
  }
  reserveTask(task: Task, key: string | undefined, requestHash: string): void {
    if (key && Number((this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE request_key IS NOT NULL').get() as Row).count) >= this.retention.idempotencyMax) throw new StoreError('IDEMPOTENCY_CAPACITY', '重复保护记录达到上限；拒绝新任务，需人工维护，未删除旧键。');
    this.db.prepare('INSERT INTO tasks(id,group_id,creator_id,audience,request_key,request_hash,draft_json) VALUES(?,?,?,?,?,?,?)').run(task.id, task.groupId, task.creatorId, task.audience, key ?? null, requestHash, JSON.stringify(task));
  }
  finishTask(task: Task): boolean {
    const result = this.db.prepare('UPDATE tasks SET result_json=? WHERE id=? AND group_id=? AND creator_id=? AND audience=? AND expired=0 AND result_json IS NULL').run(JSON.stringify(task), task.id, task.groupId, task.creatorId, task.audience);
    if (result.changes) this.prune();
    return result.changes === 1;
  }
  task(id: string): TaskReservation | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined; return row ? this.taskRecord(row) : undefined;
  }
  tasks(groupId: string, actorId: string): Task[] {
    if (!this.role(actorId, groupId)) return [];
    const rows = this.db.prepare("SELECT result_json FROM tasks WHERE group_id=? AND expired=0 AND result_json IS NOT NULL AND (audience='group' OR creator_id=?) ORDER BY rowid DESC LIMIT ?").all(groupId, actorId, this.retention.tasksPerGroup) as Row[];
    return rows.map(row => decode<Task>(row, 'result_json')!);
  }
  ownTasks(groupId: string, actorId: string): (Task & { pending: boolean })[] {
    if (!this.role(actorId, groupId)) return [];
    return (this.db.prepare('SELECT draft_json,result_json FROM tasks WHERE group_id=? AND creator_id=? AND expired=0 ORDER BY rowid DESC LIMIT 100').all(groupId, actorId) as Row[])
      .map(row => ({ ...(decode<Task>(row, 'result_json') ?? decode<Task>(row, 'draft_json')!), pending: row.result_json === null }));
  }
  /** Background native broadcast admission, never grants actor identity or tool authority. */
  nativeGroupEnabled(groupId: string, feature: NativeFeature): boolean {
    const group = decode<StoredGroup>(this.db.prepare("SELECT json FROM groups WHERE id=? AND scope='telegram'").get(groupId) as Row | undefined);
    return !!group && nativeFeatureAllowed(group.config, feature);
  }
  conversation(groupId: string, actorId: string): { messages: ConversationMessage[]; modelProfileId?: string; revision: number; audience?: Task['audience'] } {
    if (!this.role(actorId, groupId)) throw new StoreError('ACCESS_DENIED', '不能读取当前会话。');
    return decode(this.db.prepare('SELECT json FROM conversations WHERE group_id=? AND actor_id=?').get(groupId, actorId) as Row | undefined) ?? { messages: [], revision: 0 };
  }
  updateConversation(groupId: string, actorId: string, value: ReturnType<Store['conversation']>): void {
    if (!this.role(actorId, groupId)) throw new StoreError('ACCESS_DENIED', '不能修改当前会话。');
    // Bounded context, never group history or raw sandbox files.
    const messages = value.messages.slice(-12).map(message => ({ role: message.role, content: message.content.slice(0, 4000) }));
    while (Buffer.byteLength(JSON.stringify(messages)) > 24000) messages.shift();
    this.db.prepare('INSERT INTO conversations(group_id,actor_id,json) VALUES(?,?,?) ON CONFLICT(group_id,actor_id) DO UPDATE SET json=excluded.json')
      .run(groupId, actorId, JSON.stringify({ ...value, messages }));
  }
  claimTelegramDelivery(taskId: string, groupId: string, actorId: string): boolean {
    const result = this.transaction(() => {
      const row = this.task(taskId);
      const privateScope = groupId.startsWith('tg-dm:') && this.role(actorId, groupId) === 'admin';
      if ((!groupId.startsWith('tg:') && !privateScope) || !row || row.expired || row.pending || row.groupId !== groupId || row.creatorId !== actorId
        || (privateScope ? row.audience !== 'private' : row.audience !== 'group')) return false;
      const safeFailure = row.task?.status === 'failed' && row.task.featureId === 'link-cleaner' && row.task.modelCalls === 0 && row.task.output === '';
      if (row.task?.status !== 'succeeded' && !safeFailure) return false;
      if (this.db.prepare('SELECT task_id FROM telegram_deliveries WHERE task_id=?').get(taskId)) return false;
      if (Number((this.db.prepare('SELECT COUNT(*) AS count FROM telegram_deliveries').get() as Row).count) >= this.retention.deliveryMax) return false;
      this.db.prepare("INSERT INTO telegram_deliveries(task_id,group_id,actor_id,status,updated_at) VALUES(?,?,?,'claimed',?)").run(taskId, groupId, actorId, new Date().toISOString()); return true;
    });
    if (result) this.audit({ actorId, groupId, action: 'delivery.claim', targetId: taskId, outcome: 'pending' });
    return result;
  }
  recordTelegramDelivery(taskId: string, groupId: string, actorId: string, status: 'sent' | 'unknown' | 'withheld'): void {
    if (!['sent', 'unknown', 'withheld'].includes(status)) throw new StoreError('INVALID_DELIVERY', '投递状态不合法。');
    this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM telegram_deliveries WHERE task_id=?').get(taskId) as Row | undefined;
      if (existing) {
        if (existing.group_id !== groupId || existing.actor_id !== actorId) throw new StoreError('DELIVERY_SCOPE', '投递归属不一致。');
        if (existing.status === status) return;
        if (existing.status !== 'claimed') throw new StoreError('DELIVERY_FINAL', '投递结果已固化，不能重开或自动重试。');
        this.db.prepare('UPDATE telegram_deliveries SET status=?,updated_at=? WHERE task_id=?').run(status, new Date().toISOString(), taskId);
      } else {
        const row = this.task(taskId);
        const privateScope = groupId.startsWith('tg-dm:') && this.role(actorId, groupId) === 'admin';
        if (status !== 'withheld' || (!groupId.startsWith('tg:') && !privateScope) || !row || row.groupId !== groupId || row.creatorId !== actorId
          || (privateScope ? row.audience !== 'private' : row.audience !== 'group')) throw new StoreError('DELIVERY_SCOPE', '未持有匹配投递记录。');
        if (Number((this.db.prepare('SELECT COUNT(*) AS count FROM telegram_deliveries').get() as Row).count) >= this.retention.deliveryMax) throw new StoreError('DELIVERY_CAPACITY', '投递重复保护已达到上限。');
        this.db.prepare('INSERT INTO telegram_deliveries(task_id,group_id,actor_id,status,updated_at) VALUES(?,?,?,?,?)').run(taskId, groupId, actorId, status, new Date().toISOString());
      }
    });
    this.audit({ actorId, groupId, action: `delivery.${status}`, targetId: taskId, outcome: status });
  }
  audit(input: AuditInput): void {
    if (!AUDIT_ACTIONS.has(input.action) || !AUDIT_OUTCOMES.has(input.outcome) || !/^[A-Za-z0-9:_-]{1,128}$/.test(input.actorId) ||
        (input.groupId !== undefined && !/^(?:group-[ab]|tg:-[1-9][0-9]*|tg-dm:[1-9][0-9]*)$/.test(input.groupId)) ||
        (input.targetId !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(input.targetId))) throw new StoreError('INVALID_AUDIT', '审计只接受已定义的事件和标识，不接受任意正文。');
    this.db.prepare('INSERT INTO audit_log(actor_id,group_id,action,target_id,outcome,created_at) VALUES(?,?,?,?,?,?)').run(input.actorId, input.groupId ?? null, input.action, input.targetId ?? null, input.outcome, new Date().toISOString());
    this.trimAudit();
  }
  private trimAudit(): number { return Number(this.db.prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)').run(this.retention.auditMax).changes); }
  auditRecords(input: { actorId: string; groupId?: string; platformAdmin?: boolean }): AuditRecord[] {
    if (input.groupId ? this.role(input.actorId, input.groupId) !== 'admin' : !(input.platformAdmin || this.persona(input.actorId)?.platformAdmin)) return [];
    const rows = input.groupId ? this.db.prepare('SELECT * FROM audit_log WHERE group_id=? ORDER BY id DESC LIMIT ?').all(input.groupId, this.retention.auditMax) as Row[] : this.db.prepare('SELECT * FROM audit_log WHERE group_id IS NULL ORDER BY id DESC LIMIT ?').all(this.retention.auditMax) as Row[];
    return rows.map(row => ({ id: row.id as number, actorId: row.actor_id as string, ...(row.group_id ? { groupId: row.group_id as string } : {}), action: row.action as string, ...(row.target_id ? { targetId: row.target_id as string } : {}), outcome: row.outcome as string, createdAt: row.created_at as string }));
  }
  prune(): { taskBodiesRemoved: number; proposalsRemoved: number; auditRemoved: number } {
    return this.transaction(() => {
      let taskBodiesRemoved = 0, proposalsRemoved = 0;
      for (const row of this.db.prepare('SELECT id FROM groups UNION ALL SELECT id FROM private_scopes').all() as Row[]) {
        const groupId = row.id as string;
        const tasks = this.db.prepare('SELECT id,request_key FROM tasks WHERE group_id=? AND expired=0 AND result_json IS NOT NULL ORDER BY rowid DESC LIMIT -1 OFFSET ?').all(groupId, this.retention.tasksPerGroup) as Row[];
        for (const task of tasks) {
          if (task.request_key !== null) this.db.prepare("UPDATE tasks SET expired=1,draft_json='{}',result_json=NULL WHERE id=?").run(task.id as string);
          else this.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id as string);
          taskBodiesRemoved++;
        }
        proposalsRemoved += Number(this.db.prepare('DELETE FROM proposals WHERE group_id=? AND id NOT IN (SELECT id FROM proposals WHERE group_id=? ORDER BY rowid DESC LIMIT ?)').run(groupId, groupId, this.retention.proposalsPerGroup).changes);
      }
      return { taskBodiesRemoved, proposalsRemoved, auditRemoved: this.trimAudit() };
    });
  }
  backupTo(destination: string): Promise<BackupReport> {
    const path = resolve(destination);
    if (!this.backupDirectory || dirname(path) !== this.backupDirectory) throw new StoreError('BACKUP_DESTINATION', '备份只允许写入本应用 DATA_DIR/backups 目录。');
    if (existsSync(path) || path === this.filename) throw new StoreError('BACKUP_EXISTS', '备份目标已存在；未覆盖。');
    if (this.backupOperation) throw new StoreError('BACKUP_RUNNING', '已有备份进行中。');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const files = readdirSync(this.backupDirectory).map(name => statSync(join(this.backupDirectory!, name)));
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const estimated = integerPragma(this.db, 'page_count') * integerPragma(this.db, 'page_size');
    if (files.length >= this.retention.backupsMax || bytes + estimated > this.retention.backupBytesMax) throw new StoreError('BACKUP_CAPACITY', '备份数量或总大小达到上限；未覆盖或自动删除已有备份。');
    // Reserve the trusted destination exclusively before the native API (which
    // otherwise overwrites existing files). Parent directories must be trusted.
    closeSync(openSync(path, 'wx', 0o600));
    const operation = (async () => {
      try {
        await backup(this.db, path);
        chmodSync(path, 0o600);
        if (bytes + statSync(path).size > this.retention.backupBytesMax) throw new StoreError('BACKUP_CAPACITY', '备份期间数据库增长，已超出总大小上限；此次备份未保留。');
        const snapshot = new DatabaseSync(path, { readOnly: true });
        let report; try { report = verifyDatabase(snapshot); } finally { snapshot.close(); }
        return { path, ...report, sha256: await fileDigest(path) };
      } catch (error) { rmSync(path, { force: true }); throw error; }
    })();
    this.backupOperation = operation;
    void operation.finally(() => { this.backupOperation = undefined; }).catch(() => undefined);
    return operation;
  }
  static async restoreBackup(sourcePath: string, dataDir: string): Promise<BackupReport> {
    const source = resolve(sourcePath), destination = resolve(dataDir, 'groupweave.sqlite');
    if (source === destination) throw new StoreError('RESTORE_SOURCE', '恢复来源不能为目标数据库。');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const stage = join(dataDir, `.restore-${randomUUID()}.sqlite`);
    let target: Store | undefined;
    try {
      const snapshot = new DatabaseSync(source, { readOnly: true });
      try { closeSync(openSync(stage, 'wx', 0o600)); await backup(snapshot, stage); } finally { snapshot.close(); }
      const staged = new DatabaseSync(stage);
      try {
        if (integerPragma(staged, 'user_version') > STORAGE_SCHEMA_VERSION) throw new StoreError('BACKUP_SCHEMA', '备份 schema 版本不兼容。');
        migrateDatabase(staged); verifyDatabase(staged);
      } finally { staged.close(); }
      chmodSync(stage, 0o600);
      // Acquire native owner lock; an existing live owner fails before any recovery/import.
      target = new Store(dataDir);
      target.db.prepare('ATTACH DATABASE ? AS restore_source').run(stage);
      try {
        target.transaction(() => {
          for (const table of [...TABLES].reverse()) target!.db.exec(`DELETE FROM main.${table}`);
          for (const table of TABLES) target!.db.exec(`INSERT INTO main.${table} SELECT * FROM restore_source.${table}`);
        });
      } finally { target.db.exec('DETACH DATABASE restore_source'); }
      target.recover(); target.prune(); target.audit({ actorId: 'system', action: 'storage.restore', outcome: 'completed' });
      const report = verifyDatabase(target.db);
      target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const sha256 = await fileDigest(destination);
      return { path: destination, ...report, sha256 };
    } finally {
      target?.close();
      for (const path of [stage, `${stage}-wal`, `${stage}-shm`]) rmSync(path, { force: true });
    }
  }
}
