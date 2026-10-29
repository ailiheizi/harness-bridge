import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError, type BackupReport } from './store.js';

// A fixed application maintenance entrypoint, never a general command runner.
export async function runMaintenance(args: string[]): Promise<Omit<BackupReport, 'path'>> {
  const [command, ...rest] = args;
  if (command !== 'backup' && command !== 'restore') throw new StoreError('MAINTENANCE_USAGE', '仅支持 backup 或 restore 运维操作。');
  const allowed = command === 'backup' ? new Set(['--data-dir', '--output-name']) : new Set(['--source', '--data-dir', '--acknowledge-point-in-time']);
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index]!;
    if (!allowed.has(option) || options.has(option)) throw new StoreError('MAINTENANCE_USAGE', '存在未知或重复的运维选项。');
    if (option === '--acknowledge-point-in-time') options.set(option, 'true');
    else {
      const value = rest[++index];
      if (!value?.trim() || value.startsWith('--')) throw new StoreError('MAINTENANCE_USAGE', '运维选项缺少值。');
      options.set(option, value);
    }
  }
  const dataDirInput = options.get('--data-dir');
  if (!dataDirInput) throw new StoreError('MAINTENANCE_USAGE', '必须指定可信的本应用 data-dir。');
  const dataDir = resolve(dataDirInput);
  let report: BackupReport;
  if (command === 'backup') {
    const name = options.get('--output-name');
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.sqlite$/.test(name)) throw new StoreError('MAINTENANCE_USAGE', 'output-name 必须为安全的 .sqlite 文件名，不能包含路径。');
    const database = join(dataDir, 'groupweave.sqlite');
    if (!existsSync(database) || !statSync(database).isFile()) throw new StoreError('DATABASE_MISSING', '本应用持久数据库不存在；未创建空数据库冒充备份。');
    const store = new Store(dataDir);
    try { report = await store.backupTo(join(dataDir, 'backups', name)); }
    finally { await store.waitForMaintenance(); store.close(); }
  } else {
    const sourceInput = options.get('--source');
    if (!sourceInput || options.get('--acknowledge-point-in-time') !== 'true') throw new StoreError('RESTORE_ACK_REQUIRED', '恢复需要 source 和 acknowledge-point-in-time；快照不能保证其后发生的重复保护记录。');
    const source = resolve(sourceInput);
    if (!existsSync(source) || !statSync(source).isFile()) throw new StoreError('BACKUP_MISSING', '可信备份文件不存在。');
    report = await Store.restoreBackup(source, dataDir);
  }
  const { path: _path, ...safe } = report;
  return safe;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMaintenance(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const nativeCode = error && typeof error === 'object' && 'errcode' in error ? error.errcode : undefined;
    const code = error instanceof StoreError ? error.code : nativeCode === 5 ? 'OWNER_ACTIVE' : nativeCode === 13 ? 'STORAGE_CAPACITY' : 'MAINTENANCE_FAILED';
    const message = error instanceof StoreError ? error.message : nativeCode === 5 ? '数据库仍由另一个实例持有；停止实例后再维护。' : nativeCode === 13 ? '数据库或磁盘容量不足；此次维护未成功。' : '运维操作未获得成功证据；未输出原始错误或数据库内容。';
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    process.exitCode = 1;
  }
}
