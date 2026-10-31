import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { createGroupActions, type ExecutorRequest } from '../src/server/actions.js';
import { AD_REVIEW_PREFIX } from '../src/server/ad-review.js';

test('explicit AI ad review uses one real accounting path with no conversation or code tools', async () => {
  const store = new Store(); const seen: ExecutorRequest[] = [];
  store.setPluginAvailability('assistant', true); store.setPluginEnabled('assistant', true);
  const actions = createGroupActions(store, { modelProfiles: [{ id: 'approved', label: 'Approved' }, { id: 'other', label: 'Other' }], defaultModelProfileId: 'other', assistantExecutor: async request => { seen.push(request); return { output: '建议人工复核：含推广联系方式。', modelCalls: 1, toolCalls: 0 }; } });
  try {
    const proposal = await actions.previewRules('admin-a', 'group-a', { baseVersion: 1, config: { features: ['assistant', 'link-cleaner'] } });
    await actions.activateRules('admin-a', proposal.id);
    const base = { featureId: 'assistant', audience: 'private', acknowledgeExternalProcessing: true };
    await actions.runTask('admin-a', 'group-a', { ...base, input: 'private-context-canary' });
    const saved = structuredClone(store.conversation('group-a', 'admin-a'));
    const review = await actions.runTask('admin-a', 'group-a', { ...base, input: AD_REVIEW_PREFIX + '联系我领取推广福利' }, () => true, undefined, { modelProfileId: 'approved' });
    assert.equal(review.status, 'succeeded'); assert.equal(review.modelCalls, 1); assert.equal(review.modelProfileId, 'approved'); assert.equal(seen[1].options.modelProfileId, 'approved');
    assert.equal(seen[1].options.conversation, undefined); assert.equal(seen[1].options.allowLinkTool, false);
    assert.ok(!JSON.stringify(seen[1]).includes('private-context-canary'));
    assert.deepEqual(store.conversation('group-a', 'admin-a'), saved);
    await assert.rejects(actions.runTask('admin-a', 'group-a', { ...base, acknowledgeExternalProcessing: false, input: AD_REVIEW_PREFIX + 'hello' }));
  } finally { actions.close(); store.close(); }
});
