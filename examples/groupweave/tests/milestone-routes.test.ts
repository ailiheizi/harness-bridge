import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/server/app.js';
import { nativeFeatureAllowed } from '../src/server/group-config.js';
import { installNaturalRuleCommands } from '../src/server/rule-proposals.js';
import { Store } from '../src/server/store.js';
import { createGroupActions } from '../src/server/actions.js';

test('authenticated rule interpretation, confirmed configuration, model selection and file download use existing app routes', async () => {
  const calls: { input: string; context: unknown; profile: unknown }[] = [];
  const app = await buildApp({ preview: true, modelProfiles: [{ id: 'default', label: 'Default' }, { id: 'fast', label: 'Fast' }], defaultModelProfileId: 'default', assistantExecutor: async request => {
    calls.push({ input: request.input, context: request.options.conversation, profile: request.options.modelProfileId });
    const output = request.input.startsWith('仅把用户要求解释') ? JSON.stringify({ patch: { nativeFeatures: ['rss'], maxItems: 4 }, unsupported: [] }) : 'answer';
    return { output, modelCalls: 1, toolCalls: 0, artifact: { name: 'result.md', mediaType: 'text/markdown', data: new TextEncoder().encode(output) } };
  } });
  try {
    const first = await app.inject({ url: '/api/me', headers: { host: 'localhost' } });
    const headers = { host: 'localhost', origin: 'http://localhost', cookie: String(first.headers['set-cookie']).split(';')[0], 'x-csrf-token': first.json().csrfToken };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
    const get = (url: string) => app.inject({ url, headers });
    const { store, actions } = app.groupweave;
    store.setPluginEnabled('assistant', true);
    const enable = await actions.previewRules('admin-a', 'group-a', { config: { features: ['link-cleaner', 'assistant'] }, baseVersion: 1 });
    await actions.activateRules('admin-a', enable.id);
    assert.equal((await post('/api/groups/group-a/proposals/interpret', { text: '保留订阅，链接最多四条', baseVersion: 2 })).statusCode, 400);
    assert.equal(calls.length, 0);
    const result = await post('/api/groups/group-a/proposals/interpret', { text: '保留订阅，链接最多四条', baseVersion: 2, acknowledgeExternalProcessing: true });
    assert.equal(result.statusCode, 200, result.body);
    const proposal = result.json();
    assert.equal(proposal.status, 'pending');
    assert.deepEqual(proposal.warnings, []);
    assert.equal(store.group('group-a', 'admin-a')!.config.maxItems, 20);
    assert.equal(calls[0].context, undefined);
    assert.deepEqual(store.conversation('group-a', 'admin-a').messages, []);
    assert.equal((await post(`/api/proposals/${proposal.id}/activate`, {})).statusCode, 200);
    const config = store.group('group-a', 'admin-a')!.config;
    assert.equal(config.maxItems, 4); assert.equal(nativeFeatureAllowed(config, 'rss'), true); assert.equal(nativeFeatureAllowed(config, 'media'), false);
    const rollback = await post(`/api/proposals/${proposal.id}/rollback`, {});
    assert.equal(rollback.statusCode, 200); assert.equal(rollback.json().status, 'pending');
    assert.equal((await post(`/api/proposals/${rollback.json().id}/cancel`, {})).statusCode, 200);
    assert.equal((await post(`/api/proposals/${rollback.json().id}/activate`, {})).statusCode, 409);
    assert.equal((await get('/api/groups/group-a/models')).json().profiles.length, 2);
    assert.equal((await post('/api/groups/group-a/model', { id: 'fast' })).statusCode, 200);
    const task = await post('/api/groups/group-a/tasks', { featureId: 'assistant', input: 'question', audience: 'private', acknowledgeExternalProcessing: true });
    assert.equal(task.statusCode, 200, task.body); assert.equal(task.json().status, 'succeeded');
    assert.equal(calls.at(-1)!.profile, 'fast');
    const file = await get(`/api/tasks/${task.json().id}/artifact`);
    assert.equal(file.statusCode, 200, file.body); assert.equal(file.body, 'answer'); assert.match(String(file.headers['content-disposition']), /result\.md/);
    assert.equal((await get(`/api/tasks/${task.json().id}/artifact`)).statusCode, 410);
    assert.equal((await get('/api/groups/group-a/own-tasks')).json().tasks.length, 2);
    assert.equal((await post('/api/groups/group-a/conversation/reset', {})).statusCode, 200);
    assert.deepEqual(store.conversation('group-a', 'admin-a').messages, []);
    assert.equal((await get('/api/platform/native-plugins')).statusCode, 403);
  } finally { await app.close(); }
});

test('native rule command sends human replies once and never returns transport receipt IDs', async () => {
  const store = new Store();
  const actions = createGroupActions(store, { refreshRole: async () => {}, assistantExecutor: async () => ({
    output: JSON.stringify({ patch: { maxItems: 7 }, unsupported: [] }), modelCalls: 1, toolCalls: 0,
  }) });
  try {
    store.setPluginAvailability('assistant', true); store.setPluginEnabled('assistant', true);
    store.registerTelegramGroup({ chatId: -42, userId: 42, title: 'Command case' });
    store.syncTelegramMember(-42, 42, 'admin');
    const first = await actions.previewRules('tg-user:42', 'tg:-42', { config: { features: ['assistant'] }, baseVersion: 1 });
    await actions.activateRules('tg-user:42', first.id);
    let handler: any;
    const command = { option() { return this; }, action(fn: any) { handler = fn; } };
    installNaturalRuleCommands({ command() { return command; } } as any, store, actions);
    const sent: string[] = [];
    const session = { platform: 'telegram', type: 'interaction/command', event: { user: { id: '42' }, _data: { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: -42, type: 'supergroup' } } } }, async send(content: unknown) { sent.push(String(content)); return ['receipt-306']; } };
    const result = await handler({ session, options: { confirm: true } }, '链接最多七条');
    assert.equal(result, undefined);
    assert.equal(sent.length, 2);
    assert.match(sent[0], /正在解释/); assert.match(sent[1], /本群规则预览/);
    assert.equal(store.group('tg:-42', 'tg-user:42')!.config.maxItems, 20);
  } finally { actions.close(); store.close(); }
});
