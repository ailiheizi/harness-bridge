import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGroupConfigChanges, nativeFeatureAllowed, parseNativeFeatureRule } from '../src/server/group-config.js';
import type { GroupConfig } from '../src/shared.js';
const base: GroupConfig = { responseMode: 'mention', language: 'zh', features: [], deduplicate: true, sort: true, maxItems: 10 };
test('native feature allowlist preserves legacy defaults and scopes switches per group', () => {
  assert.equal(nativeFeatureAllowed(base, 'rss'), true);
  const patch = parseNativeFeatureRule('关闭 RSS');
  assert.ok(patch?.nativeFeatures);
  assert.equal(nativeFeatureAllowed({ ...base, ...patch }, 'rss'), false);
  assert.equal(nativeFeatureAllowed({ ...base, nativeFeatures: [] }, 'media'), false);
});
test('change descriptions report exact fields, scope, and no execution cost', () => {
  const changes = describeGroupConfigChanges(base, { nativeFeatures: ['rss'] });
  assert.deepEqual(changes, [{ field: 'nativeFeatures', before: undefined, after: ['rss'], scope: 'group', cost: 'none' }]);
  assert.equal(parseNativeFeatureRule('让 RSS 每天早上工作'), null);
});

import { interpretGroupRules } from '../src/server/group-config.js';
test('one natural-language request produces only a validated preview and reports unsupported effects', async () => {
  let calls = 0;
  const result = await interpretGroupRules('只留媒体，每次五条；安装插件', base, {
    knownFeatures: ['assistant'], interpret: async prompt => {
      calls++; assert.match(prompt, /不能安装插件/);
      return JSON.stringify({ patch: { nativeFeatures: ['media'], maxItems: 5 }, unsupported: ['不能安装插件'] });
    },
  });
  assert.equal(calls, 1); assert.equal(result.candidate.maxItems, 5);
  assert.equal(base.maxItems, 10); assert.equal(result.candidate.language, 'zh');
  assert.deepEqual(result.warnings, ['不能安装插件']); assert.equal(result.cost.interpretation, 'unknown');
});
test('missing AI and invalid or authority-expanding output produce warnings without changes', async () => {
  const missing = await interpretGroupRules('make quieter', base, { knownFeatures: [] });
  assert.equal(missing.changes.length, 0); assert.ok(missing.warnings.length);
  for (const output of ['not json', '{"patch":{"platformAdmin":true},"unsupported":[]}', '{"patch":{"nativeFeatures":["execute"]},"unsupported":[]}']) {
    const result = await interpretGroupRules('change group', base, { knownFeatures: [], interpret: async () => output });
    assert.deepEqual(result.patch, {}); assert.ok(result.warnings.length);
  }
  assert.deepEqual(parseNativeFeatureRule('开启 rss', { ...base, nativeFeatures: [] }), { nativeFeatures: ['rss'] });
  assert.deepEqual(parseNativeFeatureRule('关闭图片', { ...base, nativeFeatures: ['rss', 'image'] }), { nativeFeatures: ['rss'] });
});
