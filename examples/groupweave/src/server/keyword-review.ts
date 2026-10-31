import type { Executor } from './actions.js';
import { DEFAULT_REVIEW_KEYWORDS } from '../review-keywords.js';
export { DEFAULT_REVIEW_KEYWORDS } from '../review-keywords.js';

const MAX_INPUT_BYTES = 8_192;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_LENGTH = 80;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/gu;

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(ZERO_WIDTH, '').replace(/\s/gu, '');
}

export const keywordReview: Executor = async (request, signal) => {
  signal?.throwIfAborted();
  if (request.authorized !== true || request.featureId !== 'antiad' || !['private', 'group'].includes(request.audience)
    || !request.actorId?.trim() || !request.groupId?.trim() || request.groupId.startsWith('tg-dm:')
    || !request.tenantId?.trim() || request.tenantId !== request.groupId) {
    throw new Error('关键词复核拒绝无效 scope 或权限。');
  }
  if (typeof request.input !== 'string' || !request.input.trim() || Buffer.byteLength(request.input, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('关键词复核输入无效或超过 8192 字节。');
  }
  const configured = request.options.antiadStopwords;
  const keywords: readonly string[] = configured === undefined ? DEFAULT_REVIEW_KEYWORDS : configured;
  if (!Array.isArray(keywords) || keywords.length > MAX_KEYWORDS || keywords.some(word => typeof word !== 'string'
    || !normalize(word) || word.length > MAX_KEYWORD_LENGTH)) {
    throw new Error('关键词规则无效。');
  }
  const output = keywords.length === 0
    ? '未配置关键词规则，不做风险判定。'
    : (() => {
      const text = normalize(request.input);
      const matches = keywords.filter(word => text.includes(normalize(word)));
      return matches.length
        ? `关键词规则命中：${matches.join('、')}。仅规则命中建议，未运行训练分类器，不自动处罚。`
        : '未命中本群关键词，不代表内容安全。';
    })();
  signal?.throwIfAborted();
  return { output, modelCalls: 0 };
};
