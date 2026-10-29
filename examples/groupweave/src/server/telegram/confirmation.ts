import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type AiFeature = 'digest' | 'link-brief' | 'assistant';
export type InputMode = 'command' | 'reply' | 'mention';
export interface Confirmation {
  featureId: AiFeature;
  groupId: string;
  userId: string;
  messageId: number;
  updateId: number;
  input: string;
  mode: InputMode;
  targeted: boolean;
}
const TTL_SECONDS = 300;
const MAX_CONSUMED = 512;
const encode = (value: number) => value.toString(36);
const number = (value: string) => /^[0-9a-z]+$/.test(value) ? Number.parseInt(value, 36) : NaN;

/** Native Telegram callback authentication; no input bodies are retained here. */
export function createTelegramConfirmations(now: () => number = Date.now) {
  const key = randomBytes(32);
  // Only consumed signatures and expirations. Full ledger rejects new use rather
  // than dropping live replay protection. Restart invalidates all old signatures.
  const consumed = new Map<string, number>();
  const signature = (body: string, groupId: string, input: string) => createHmac('sha256', key)
    .update(`${body}\0${groupId}\0${input}`).digest().subarray(0, 10).toString('base64url');
  const currentSeconds = () => Math.floor(now() / 1000);
  function prune() { for (const [token, expiry] of consumed) if (expiry < currentSeconds()) consumed.delete(token); }
  function issue(request: Confirmation) {
    const mode = request.mode === 'mention' ? 'm' : request.mode === 'reply' ? 'r' : 'c';
    const body = ['gw:a', request.featureId === 'digest' ? 'd' : request.featureId === 'assistant' ? 'a' : 'b', request.targeted ? mode.toUpperCase() : mode,
      encode(Number(request.userId)), encode(request.messageId), encode(request.updateId), encode(currentSeconds() + TTL_SECONDS)].join(':');
    const token = `${body}:${signature(body, request.groupId, request.input)}`;
    if (Buffer.byteLength(token) > 64) throw new Error('TELEGRAM_CONFIRMATION_TOO_LONG');
    return token;
  }
  function inspect(token: string) {
    const match = /^gw:a:([dba]):([crmCRM]):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+):([A-Za-z0-9_-]{14})$/.exec(token);
    if (!match) return undefined;
    const [, feature, code, user, message, update, expires] = match;
    const userId = number(user); const messageId = number(message); const updateId = number(update); const expiry = number(expires);
    if (![userId, messageId, updateId, expiry].every(Number.isSafeInteger) || userId < 1 || messageId < 1 || updateId < 0
      || expiry < currentSeconds() || expiry > currentSeconds() + TTL_SECONDS) return undefined;
    return { featureId: feature === 'd' ? 'digest' as const : feature === 'a' ? 'assistant' as const : 'link-brief' as const, userId: String(userId), messageId, updateId, expiry,
      mode: code.toLowerCase() === 'm' ? 'mention' as const : code.toLowerCase() === 'r' ? 'reply' as const : 'command' as const,
      targeted: code === code.toUpperCase() };
  }
  function consume(token: string, request: Confirmation) {
    const decoded = inspect(token); if (!decoded) return false;
    if (decoded.userId !== request.userId || decoded.messageId !== request.messageId || decoded.updateId !== request.updateId
      || decoded.featureId !== request.featureId || decoded.mode !== request.mode || decoded.targeted !== request.targeted) return false;
    const separator = token.lastIndexOf(':'); const body = token.slice(0, separator);
    const expected = Buffer.from(signature(body, request.groupId, request.input)); const actual = Buffer.from(token.slice(separator + 1));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    prune(); if (consumed.has(token) || consumed.size >= MAX_CONSUMED) return false;
    consumed.set(token, decoded.expiry); return true;
  }
  // Cancellation grants only the explicitly bound user's current group tasks.
  function cancelButton(groupId: string, userId: string, messageId: number) {
    const body = `gw:c:${encode(Number(userId))}:${encode(messageId)}:${encode(currentSeconds() + TTL_SECONDS)}`;
    return `${body}:${signature(body, groupId, '')}`;
  }
  function consumeCancel(token: string, groupId: string, userId: string, messageId: number) {
    const match = /^gw:c:([0-9a-z]+):([0-9a-z]+):([0-9a-z]+):([A-Za-z0-9_-]{14})$/.exec(token);
    if (!match || number(match[1]) !== Number(userId) || number(match[2]) !== messageId
      || number(match[3]) < currentSeconds() || number(match[3]) > currentSeconds() + TTL_SECONDS) return false;
    const separator = token.lastIndexOf(':'); const expected = Buffer.from(signature(token.slice(0, separator), groupId, ''));
    const actual = Buffer.from(token.slice(separator + 1));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    prune(); if (consumed.has(token) || consumed.size >= MAX_CONSUMED) return false;
    consumed.set(token, number(match[3])); return true;
  }
  return { issue, inspect, consume, cancelButton, consumeCancel };
}
