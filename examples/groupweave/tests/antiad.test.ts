import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAntiadExecutor, AntiadError, type AntiadExecutor, type AntiadRequest } from '../src/server/antiad.js';

const python = process.env.ANTIAD_TEST_PYTHON;
const pythonTest = (name: string, body: () => Promise<void>) => test(name, { skip: python ? false : 'Set ANTIAD_TEST_PYTHON to a trusted Python with integrations/antiad/requirements.txt installed; no synthetic model is shipped as production readiness.' }, body);
const integration = fileURLToPath(new URL('../integrations/antiad/', import.meta.url));
let dir: string;
let model: string;
let executor: AntiadExecutor;

const request = (changes: Partial<AntiadRequest> = {}): AntiadRequest => ({
  actorId: 'member-a', groupId: 'group-a', input: '今天晚上讨论开源项目，欢迎大家一起学习。',
  audience: 'private', authorized: true,
  rules: { promptThreshold: 0.55, actionThreshold: 0.90, stopwords: [] },
  ...changes,
});
function run(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python!, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
before(async () => {
  if (!python) return;
  dir = await mkdtemp(join(tmpdir(), 'groupweave-antiad-test-'));
  // Spaces and shell metacharacters in a deployment path remain literal argv.
  model = join(dir, 'trusted $(never-run) model.joblib');
  const seed = await run(['-E', '-s', '-B', '-c', `
import sys
sys.path.insert(0, ${JSON.stringify(integration)})
from antiad.model import TextClassifier
texts=['加微信领取返利赚钱投资', '免费赚大钱加好友代理广告', '广告推广联系微信发财', '优惠返佣加入推广代理', '今晚讨论开源项目一起学习', '明天一起打球吃饭聊天', '周末去公园散步运动', '这个程序的测试已经通过']
TextClassifier().fit(texts,[1,1,1,1,0,0,0,0]).save(${JSON.stringify(model)})
`]);
  assert.equal(seed.code, 0, seed.stderr);
  await chmod(model, 0o444);
  executor = await createAntiadExecutor({ pythonPath: python!, modelPath: model });
});
after(async () => {
  if (!python) return;
  await executor?.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('deployment paths are administrator-managed absolute paths and timeouts are bounded', async () => {
  await assert.rejects(createAntiadExecutor({ pythonPath: 'python3', modelPath: '/trusted/model.joblib' }), error => error instanceof AntiadError && error.code === 'INVALID_INPUT');
  await assert.rejects(createAntiadExecutor({ pythonPath: '/usr/bin/python3', modelPath: 'from-user.joblib' }), error => error instanceof AntiadError && error.code === 'INVALID_INPUT');
  await assert.rejects(createAntiadExecutor({ pythonPath: '/usr/bin/python3', modelPath: '/trusted/model.joblib', timeoutMs: 60_000 }), error => error instanceof AntiadError && error.code === 'INVALID_INPUT');
});

pythonTest('actual private upstream TextClassifier and Scorer execute and return evidence with zero model calls', async () => {
  const verdict = await executor.classify(request());
  assert.equal(verdict.classifierReady, true);
  assert.ok(verdict.contributions.some(item => item.name === 'classifier'));
  assert.ok(verdict.total >= 0 && verdict.total <= 1);
  const knownSpam = await executor.classify(request({ input: '加微信领取返利赚钱投资' }));
  const knownHam = await executor.classify(request({ input: '今晚讨论开源项目一起学习' }));
  assert.ok(knownSpam.contributions.find(item => item.name === 'classifier')!.score > knownHam.contributions.find(item => item.name === 'classifier')!.score);
  assert.ok(knownSpam.contributions.some(item => item.name === 'duplicate'));
  const result = await executor(request());
  assert.equal(result.modelCalls, 0);
  assert.match(result.output, /已实际运行/);
  assert.match(result.output, /未删除消息、禁言、封禁或训练模型/);
  assert.doesNotMatch(result.output, /今天晚上|member-a|group-a/);
});

pythonTest('fresh group rules affect only their own request and the shared read-only model is unchanged', async () => {
  const beforeModel = await readFile(model);
  const text = '群甲特定词今晚讨论学习';
  const a = await executor.classify(request({ input: text, rules: { promptThreshold: .55, actionThreshold: .9, stopwords: ['群甲特定词'] } }));
  const b = await executor.classify(request({ actorId: 'member-b', groupId: 'group-b', input: text, rules: { promptThreshold: .999999, actionThreshold: 1, stopwords: [] } }));
  const aAgain = await executor.classify(request({ input: text, rules: { promptThreshold: .55, actionThreshold: .9, stopwords: ['群甲特定词'] } }));
  assert.equal(a.recommendation, 'high-confidence-review');
  assert.equal(b.recommendation, 'allow');
  assert.ok(a.contributions.some(item => item.name === 'stopwords'));
  assert.ok(!b.contributions.some(item => item.name === 'stopwords'));
  assert.deepEqual(aAgain, a);
  assert.deepEqual(await readFile(model), beforeModel);
});

pythonTest('group rule changes after submission cannot mutate the snapshot used by an active child', async () => {
  const words = ['群甲特定词'];
  const rules = { promptThreshold: .55, actionThreshold: .9, stopwords: words };
  const pending = executor.classify(request({ input: '群甲特定词今晚讨论学习', rules }));
  words.length = 0;
  rules.promptThreshold = 1;
  const result = await pending;
  assert.equal(result.recommendation, 'high-confidence-review');
  assert.ok(result.contributions.some(item => item.name === 'stopwords'));
});

pythonTest('missing or corrupt models block readiness even when group rules could match every message', async () => {
  await assert.rejects(createAntiadExecutor({ pythonPath: python!, modelPath: join(dir, 'missing.joblib') }), error => error instanceof AntiadError && error.code === 'MODEL_UNAVAILABLE');
  const corrupt = join(dir, 'corrupt private model.joblib');
  await writeFile(corrupt, 'not a model');
  await assert.rejects(createAntiadExecutor({ pythonPath: python!, modelPath: corrupt }), error => error instanceof AntiadError && error.code === 'MODEL_UNAVAILABLE' && !error.message.includes(dir));
});

pythonTest('trusted host rejects unauthorized scopes, oversized text, unknown rule fields and malformed thresholds', async () => {
  for (const changes of [{ authorized: false }, { actorId: ' ' }, { groupId: '' }] as Partial<AntiadRequest>[]) {
    await assert.rejects(executor.classify(request(changes)), error => error instanceof AntiadError && error.code === 'UNAUTHORIZED');
  }
  await assert.rejects(executor.classify(request({ input: '甲'.repeat(2_731) })), error => error instanceof AntiadError && error.code === 'INPUT_LIMIT');
  for (const rules of [
    { promptThreshold: .9, actionThreshold: .55, stopwords: [] },
    { promptThreshold: NaN, actionThreshold: .9, stopwords: [] },
    { promptThreshold: .55, actionThreshold: .9, stopwords: [], modelPath: '/other-group/model.joblib' },
    { promptThreshold: .55, actionThreshold: .9, stopwords: ['x'.repeat(81)] },
    { promptThreshold: .55, actionThreshold: .9, stopwords: Array(51).fill('x') },
  ]) await assert.rejects(executor.classify(request({ rules })), error => error instanceof AntiadError && error.code === 'INVALID_INPUT');
});

pythonTest('message syntax is data and never becomes shell syntax, flags, identities or model paths', async () => {
  const marker = join(dir, 'must-not-exist');
  const input = `$(touch ${marker}) --model /other-group/model.joblib --probe <script>私人信息</script>`;
  const verdict = await executor.classify(request({ input }));
  assert.equal(verdict.classifierReady, true);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

pythonTest('a disappeared model after readiness produces a blocked failure without rule-only fallback', async () => {
  const path = join(dir, 'temporary.joblib');
  await writeFile(path, await readFile(model));
  const temporary = await createAntiadExecutor({ pythonPath: python!, modelPath: path });
  try {
    await rm(path);
    await assert.rejects(temporary.classify(request({ rules: { promptThreshold: .55, actionThreshold: .9, stopwords: ['今天'] } })), error => error instanceof AntiadError && error.code === 'MODEL_UNAVAILABLE');
  } finally { await temporary.dispose(); }
});

pythonTest('pre-aborted requests never launch work and bounded concurrency rejects extra children', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled fixture'));
  await assert.rejects(executor.classify(request(), controller.signal), /cancelled fixture/);
  const active = executor.classify(request());
  await assert.rejects(executor.classify(request({ groupId: 'group-b' })), error => error instanceof AntiadError && error.code === 'BUSY');
  await active;
});

async function launcher(): Promise<{ path: string; pidFile: string; gate: string }> {
  const path = join(dir, `interpreter-${Math.random().toString(36).slice(2)}`);
  const pidFile = `${path}.pid`;
  const gate = `${path}.gate`;
  // A test-only executable Python launcher records its pid and, when gated,
  // ignores TERM. Production still has exactly the fixed adapter argv.
  await writeFile(path, `#!${python}\nimport os,signal,sys,time\nif os.path.exists(${JSON.stringify(gate)}):\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\n time.sleep(10)\nelse:\n open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\nos.execv(${JSON.stringify(python)},[${JSON.stringify(python)},*sys.argv[1:]])\n`);
  await chmod(path, 0o755);
  return { path, pidFile, gate };
}
async function nextPid(path: string, previous: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = Number(await readFile(path, 'utf8').catch(() => ''));
    if (current && current !== previous) return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('test launcher did not start');
}
function assertDead(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

pythonTest('abort and dispose wait for the actual TERM-ignoring child to be killed and drained', async () => {
  const fixture = await launcher();
  const controlled = await createAntiadExecutor({ pythonPath: fixture.path, modelPath: model });
  const initial = Number(await readFile(fixture.pidFile, 'utf8'));
  await writeFile(fixture.gate, 'synthetic test gate');
  const controller = new AbortController();
  const pending = controlled.classify(request(), controller.signal);
  const settled = pending.catch(error => error);
  const pid = await nextPid(fixture.pidFile, initial);
  controller.abort(new Error('stop actual child'));
  await controlled.dispose();
  assert.match((await settled).message, /stop actual child/);
  assertDead(pid);
  await assert.rejects(controlled.classify(request()), error => error instanceof AntiadError && error.code === 'CLOSED');
});

pythonTest('timeout kills a real hung child, drains it and allows another request', async () => {
  const fixture = await launcher();
  const controlled = await createAntiadExecutor({ pythonPath: fixture.path, modelPath: model, timeoutMs: 4_000 });
  try {
    const initial = Number(await readFile(fixture.pidFile, 'utf8'));
    await writeFile(fixture.gate, 'synthetic test gate');
    const pending = controlled.classify(request());
    const settled = pending.catch(error => error);
    const pid = await nextPid(fixture.pidFile, initial);
    const error = await settled;
    assert.ok(error instanceof AntiadError && error.code === 'TIMEOUT');
    assertDead(pid);
    await rm(fixture.gate);
    assert.equal((await controlled.classify(request())).classifierReady, true);
  } finally { await controlled.dispose(); }
});

pythonTest('the CLI independently rejects cross-scope fields and malformed input without echoing private content', async () => {
  const privateInput = 'synthetic-private-text-do-not-echo';
  const base = { text: privateInput, rules: { promptThreshold: .55, actionThreshold: .9, stopwords: [] }, message: { userId: 0, fullName: '', username: '', isForward: false } };
  for (const input of [
    JSON.stringify({ ...base, groupId: 'another-group' }),
    JSON.stringify({ ...base, rules: { ...base.rules, modelPath: '/another-group' } }),
    JSON.stringify({ ...base, message: { ...base.message, userId: true } }),
    JSON.stringify({ ...base, rules: { ...base.rules, promptThreshold: 1, actionThreshold: .5 } }),
    '{"text":NaN}',
    'x'.repeat(16_385),
  ]) {
    const result = await run(['-E', '-s', '-B', join(integration, 'worker.py'), '--model', model], input);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /INVALID_INPUT|INPUT_LIMIT/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-text|another-group/);
    assert.equal(result.stderr, '');
  }
});
