import assert from 'node:assert/strict';
import test from 'node:test';
import { keywordReview, DEFAULT_REVIEW_KEYWORDS } from '../src/server/keyword-review.js';
import type { ExecutorRequest } from '../src/server/actions.js';

function request(overrides: Partial<ExecutorRequest> = {}): ExecutorRequest {
  return {
    taskId: 'task-1', actorId: 'tg-user:1', groupId: 'tg:-1001', tenantId: 'tg:-1001', featureId: 'antiad',
    authorization: { platformVersion: 1, groupVersion: 1 }, input: '这是一条普通消息',
    options: { deduplicate: false, sort: false, maxItems: 20, antiadPromptThreshold: 0.55, antiadActionThreshold: 0.9 },
    audience: 'group', authorized: true, ...overrides,
  };
}

test('keyword review normalizes Chinese text and matches the visible defaults with no classifier claim', async () => {
  assert.deepEqual(DEFAULT_REVIEW_KEYWORDS, ['加群领福利', '稳赚不赔', '免费领取', '兼职刷单', '代开发票']);
  const result = await keywordReview(request({ input: '  ＂免 费　领​取＂ ' }));
  assert.equal(result.modelCalls, 0);
  const privateResult = await keywordReview(request({ input: '免费领取', audience: 'private' }));
  assert.equal(privateResult.modelCalls, 0);
  assert.match(result.output, /免费领取/);
  assert.match(result.output, /仅规则命中建议，未运行训练分类器，不自动处罚/);
  assert.doesNotMatch(result.output, /概率|分类器已运行/);
});

test('keyword review isolates group rules, honors an explicit empty list, and rejects cancellation or invalid scope', async () => {
  const text = '本群专属优惠词';
  const groupA = await keywordReview(request({ input: text, options: { ...request().options, antiadStopwords: ['本群专属优惠词'] } }));
  const groupB = await keywordReview(request({ groupId: 'tg:-1002', tenantId: 'tg:-1002', input: text, options: { ...request().options, antiadStopwords: ['另一群关键词'] } }));
  assert.match(groupA.output, /本群专属优惠词/);
  assert.match(groupB.output, /未命中本群关键词，不代表内容安全/);
  const noRules = await keywordReview(request({ options: { ...request().options, antiadStopwords: [] } }));
  assert.match(noRules.output, /未配置关键词规则，不做风险判定/);
  await assert.rejects(keywordReview(request({ featureId: 'assistant' })), /scope|权限/u);
  await assert.rejects(keywordReview(request({ authorized: false })), /scope|权限/u);
  await assert.rejects(keywordReview(request({ options: { ...request().options, antiadStopwords: ['\u200b'] } })), /规则无效/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(keywordReview(request(), controller.signal), /abort|cancel/i);
});

test('host publishes the actual keyword backend without enabling it and private Web tasks keep group rules', async () => {
  const { buildApp } = await import('../src/server/app.js');
  const app = await buildApp({ preview: true, antiadExecutor: keywordReview, antiadBackend: 'keywords' });
  try {
    const { store, actions } = app.groupweave;
    assert.equal(store.plugin('antiad')?.available, true);
    assert.equal(store.plugin('antiad')?.enabled, false);
    assert.equal(store.plugin('antiad')?.reviewBackend, 'keywords');
    store.setPluginEnabled('antiad', true);
    const group = store.group('group-a', 'admin-a')!;
    const proposal = await actions.previewRules('admin-a', group.id, {
      baseVersion: group.version, config: { ...group.config, features: [...group.config.features, 'antiad'] },
    });
    await actions.activateRules('admin-a', proposal.id);
    const task = await actions.runTask('admin-a', group.id, { input: '免费领取', featureId: 'antiad', audience: 'private' });
    assert.equal(task.status, 'succeeded'); assert.equal(task.modelCalls, 0);
    assert.match(task.output, /免费领取/);
    await assert.rejects(actions.runTask('admin-a', 'group-b', { input: '免费领取', featureId: 'antiad', audience: 'private' }), /成员|权限|不存在|可访问/u);
  } finally { await app.close(); }
});


test('clearing default keyword rules is visible and rollback restores default semantics', async () => {
  const { buildApp } = await import('../src/server/app.js');
  const app = await buildApp({ preview: true, antiadExecutor: keywordReview, antiadBackend: 'keywords' });
  try {
    const { store, actions } = app.groupweave;
    store.setPluginEnabled('antiad', true);
    const group = store.group('group-a', 'admin-a')!;
    const empty = await actions.previewRules('admin-a', group.id, { baseVersion: group.version, config: { antiadStopwords: [] } });
    assert.ok(empty.changes.some(text => /关键词/.test(text) && /默认/.test(text) && /0/.test(text)), 'default to empty must not be invisible');
    await actions.activateRules('admin-a', empty.id);
    assert.deepEqual(store.group(group.id, 'admin-a')!.config.antiadStopwords, []);
    const restore = await actions.rollbackRules('admin-a', empty.id);
    assert.equal(restore.candidate.antiadStopwords, undefined, 'rollback restores missing-field defaults, not current empty rules');
    await actions.activateRules('admin-a', restore.id);
    assert.equal(store.group(group.id, 'admin-a')!.config.antiadStopwords, undefined);
  } finally { await app.close(); }
});
