import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createGroupActions, type ExecutorRequest } from '../src/server/actions.js';
const request = (input: string) => ({ input, featureId: 'assistant', audience: 'private', acknowledgeExternalProcessing: true });
test('explicit bounded actor context, reset vs late write, restart history and interruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-session-')); let store = new Store(dir);
  const seen: ExecutorRequest[] = []; let hold: (() => void) | undefined;
  const actions = createGroupActions(store, { modelProfiles: [{ id: 'approved', label: 'Approved' }], defaultModelProfileId: 'approved', assistantExecutor: async req => {
    seen.push(req); if (req.input === 'late') await new Promise<void>(resolve => { hold = resolve; });
    return { output: 'answer', modelCalls: 1, toolCalls: 0, artifact: { name: 'result.md', mediaType: 'text/markdown', data: new TextEncoder().encode('answer') } };
  } });
  try {
    store.setPluginAvailability('assistant', true); store.setPluginEnabled('assistant', true);
    const proposal = await actions.previewRules('admin-a', 'group-a', { baseVersion: 1, config: { features: ['assistant'] } }); await actions.activateRules('admin-a', proposal.id);
    const first = await actions.runTask('admin-a', 'group-a', request('first'));
    assert.equal(first.status, 'succeeded'); assert.equal(first.modelProfileId, 'approved'); assert.deepEqual(seen[0].options.conversation, []);
    assert.equal(first.artifact?.bytes, 6); assert.equal(actions.takeTaskArtifact('member', first.id), undefined);
    assert.equal(actions.takeTaskArtifact('admin-a', first.id)?.data.length, 6); assert.equal(actions.takeTaskArtifact('admin-a', first.id), undefined);
    await actions.runTask('admin-a', 'group-a', request('followup')); assert.equal(seen[1].options.conversation?.[0].content, 'first');
    assert.deepEqual(store.conversation('group-a', 'member').messages, []);
    await assert.rejects(actions.ownTask('member', 'group-a', first.id)); await assert.rejects(actions.selectModel('admin-a', 'group-a', 'https://arbitrary'));
    await actions.selectModel('admin-a', 'group-a', 'approved');
    const late = actions.runTask('admin-a', 'group-a', request('late')); while (!hold) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await actions.ownTasks('admin-a', 'group-a')).some(task => task.pending && task.input === 'late'), true);
    await actions.resetConversation('admin-a', 'group-a'); hold(); await late; assert.deepEqual(store.conversation('group-a', 'admin-a').messages, []);
    const final = await actions.runTask('admin-a', 'group-a', request('new subject')); assert.deepEqual(seen[3].options.conversation, []);
    await actions.runTask('admin-a', 'group-a', request('rules helper'), () => true, undefined, { conversation: false });
    assert.equal(seen[4].options.conversation, undefined); assert.equal(store.conversation('group-a', 'admin-a').messages.length, 2);
    const beforeTranslation = store.conversation('group-a', 'admin-a').messages;
    await actions.runTask('admin-a', 'group-a', request('Translate the following text into English. Preserve its meaning and tone. Return only the translation.\n\nText:\n你好'));
    assert.equal(seen[5].options.conversation, undefined);
    assert.deepEqual(store.conversation('group-a', 'admin-a').messages, beforeTranslation);
    store.reserveTask({ ...final, id: 'interrupted', input: 'unfinished' }, 'interrupted-key', 'hash'); actions.close(); store.close(); store = new Store(dir);
    assert.equal(store.conversation('group-a', 'admin-a').messages[0].content, 'new subject'); assert.equal(store.conversation('group-a', 'admin-a').modelProfileId, 'approved');
    assert.equal(store.task('interrupted')?.pending, false); assert.match(store.task('interrupted')!.task!.error!, /未自动重放/);
    assert.equal(store.tasks('group-a', 'admin-a').some(task => task.id === first.id), true);
    const resumed = createGroupActions(store, { modelProfiles: [{ id: 'approved', label: 'Approved' }], assistantExecutor: async req => { assert.deepEqual(req.options.conversation, []); return { output: 'public answer', modelCalls: 1, toolCalls: 0 }; } });
    await resumed.runTask('admin-a', 'group-a', { ...request('public question'), audience: 'group' });
    assert.equal(store.conversation('group-a', 'admin-a').audience, 'group');
    assert.equal(store.conversation('group-a', 'admin-a').modelProfileId, 'approved');
    assert.equal(store.conversation('group-a', 'admin-a').messages[0].content, 'public question');
    resumed.close();
    store.updateConversation('group-a', 'admin-a', { messages: Array.from({ length: 40 }, () => ({ role: 'user', content: 'x'.repeat(8000) })), revision: 0 });
    const context = store.conversation('group-a', 'admin-a').messages; assert.ok(context.length <= 12); assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 24000);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('cancel pending owner/admin only; rollback is a fresh versioned preview', async () => {
  const store = new Store(); const actions = createGroupActions(store);
  try {
    const native = await actions.previewRules('admin-a', 'group-a', { baseVersion: 1, config: { nativeFeatures: [] }, text: '开启图片，开启RSS，关闭图片' });
    assert.deepEqual(native.candidate.nativeFeatures, ['rss']);
    const first = await actions.previewRules('admin-a', 'group-a', { baseVersion: 1, config: { language: 'en', nativeFeatures: [] } });
    await assert.rejects(actions.cancelRules('member', first.id)); assert.equal((await actions.cancelRules('admin-a', first.id)).status, 'cancelled'); await assert.rejects(actions.activateRules('admin-a', first.id));
    const next = await actions.previewRules('admin-a', 'group-a', { baseVersion: 1, config: { language: 'en' } }); await actions.activateRules('admin-a', next.id);
    const rollback = await actions.rollbackRules('admin-a', next.id); assert.equal(rollback.status, 'pending'); assert.equal(rollback.baseVersion, 2); assert.equal(store.group('group-a', 'admin-a')!.config.language, 'en');
    const concurrent = await actions.previewRules('admin-a', 'group-a', { baseVersion: 2, config: { sort: true } }); await actions.activateRules('admin-a', concurrent.id);
    await assert.rejects(actions.activateRules('admin-a', rollback.id), /旧配置/); const retry = await actions.rollbackRules('admin-a', next.id); await actions.activateRules('admin-a', retry.id); assert.equal(store.group('group-a', 'admin-a')!.config.language, 'zh');
  } finally { store.close(); }
});

test('task cancellation uses current owner; private conversations and native commands stay in current chat', async () => {
  const { createTelegramBinding } = await import('../src/server/telegram-binding.js');
  const { installSessionCommands } = await import('../src/server/koishi-session.js');
  const store = new Store(); let entered = false;
  const actions = createGroupActions(store, { modelProfiles: [{ id: 'approved', label: 'Approved' }], assistantExecutor: async (_req, signal) => {
    entered = true; await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return { output: 'late', modelCalls: 1, toolCalls: 0 };
  } });
  try {
    store.setPluginAvailability('assistant', true); store.setPluginEnabled('assistant', true);
    store.ensureTelegramPrivate(42); store.ensureTelegramPrivate(43);
    assert.equal(store.nativeGroupEnabled('tg-dm:42', 'rss'), false);
    assert.equal(store.nativeGroupEnabled('tg:-999', 'rss'), false);
    store.registerTelegramGroup({ chatId: -999, title: 'RSS native admission', userId: 42 });
    assert.equal(store.nativeGroupEnabled('tg:-999', 'rss'), true);
    const binding = createTelegramBinding(store, actions, { scope: 'private' });
    const actor = { groupId: '42', userId: '42', role: 'member' as const };
    const running = binding.executeFeature!({ actor, input: 'cancel me', featureId: 'assistant', audience: 'private', idempotencyKey: 'private-cancel', updateId: 1, messageId: 1, externalProcessingAcknowledged: true });
    while (!entered) await new Promise(resolve => setImmediate(resolve));
    const task = (await binding.ownTasks!(actor))[0]; assert.equal(task.pending, true);
    await assert.rejects(binding.cancelTask!({ ...actor, userId: '43', groupId: '43' }, task.id));
    assert.equal(await binding.cancelOwnTasks!(actor), 1); assert.equal((await running).status, 'blocked');
    assert.deepEqual(store.conversation('tg-dm:42', 'tg-user:42').messages, []);
    assert.throws(() => store.conversation('tg-dm:42', 'tg-user:43'));
    const handlers = new Map<string, Function>();
    installSessionCommands({ command(name: string) { return { action(fn: Function) { handlers.set(name.split(' ')[0], fn); } }; } } as any, binding, { privateBinding: binding });
    const sent: any[] = [];
    const session: any = { platform: 'telegram', type: 'interaction/command', isDirect: true, channelId: '42', bot: { user: { name: 'testbot' } }, event: { user: { id: '42' }, _data: { update_id: 2, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, message_id: 2, text: '/tasks' } } }, async send(content: any) { sent.push(String(content)); return ['receipt']; } };
    await handlers.get('tasks')!({ session }); assert.match(sent.join(''), new RegExp(task.id));
    session.event._data.message.chat.id = 43; sent.length = 0;
    await handlers.get('tasks')!({ session }); assert.equal(sent.length, 0);
  } finally { actions.close(); store.close(); }
});
