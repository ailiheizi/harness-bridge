import { setImmediate as yieldExecution } from 'node:timers/promises';
import { HarnessError } from '@deepseek-ai/dsh-llm';

export interface LinkOptions { deduplicate: boolean; sort: boolean; maxItems: number; language?: 'zh' | 'en' }

const MAX_INPUT_LENGTH = 50_000;
const MAX_ITEMS = 1_000;
const INPUT_ERRORS = {
  NO_LINKS: '没有找到有效的 http(s) 链接。',
  INPUT_LIMIT: '输入过长，最多允许 50000 个字符。',
  MAX_ITEMS: 'maxItems 必须是 1 到 1000 之间的整数。',
} as const;
type NativeInputCode = keyof typeof INPUT_ERRORS;

/** Only these fixed messages may be shown as business input errors by the server. */
export class NativeInputError extends HarnessError {
  declare readonly code: NativeInputCode;
  constructor(code: NativeInputCode) { super(INPUT_ERRORS[code], code); }
}

export function isInputCode(value: unknown): value is NativeInputCode {
  return typeof value === 'string' && Object.hasOwn(INPUT_ERRORS, value);
}

/** Only inspects this request's text. It performs no URL fetch or file access. */
export async function cleanLinks(input: string, options: LinkOptions, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (input.length > MAX_INPUT_LENGTH) throw new NativeInputError('INPUT_LIMIT');
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > MAX_ITEMS) {
    throw new NativeInputError('MAX_ITEMS');
  }

  // Let the host deliver cancellation before work, then at bounded intervals.
  // This is cooperative cancellation; a synchronous URL parse/sort is not a kill boundary.
  await yieldExecution(undefined, { signal });

  const links: string[] = [];
  let inspected = 0;
  for (const match of input.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    signal.throwIfAborted();
    let text = match[0].replace(/[，。；！？、,;]+$/u, '');
    // Count once rather than repeatedly splitting a shrinking string (quadratic
    // for a valid input ending in many unmatched brackets). Preserve pair order.
    const pairs = [['(', ')'], ['[', ']'], ['{', '}']] as const;
    const excess = [0, 0, 0];
    for (const character of text) {
      if (++inspected % 4096 === 0) await yieldExecution(undefined, { signal });
      for (let index = 0; index < pairs.length; index += 1) {
        if (character === pairs[index][0]) excess[index] -= 1;
        else if (character === pairs[index][1]) excess[index] += 1;
      }
    }
    let end = text.length;
    for (let index = 0; index < pairs.length; index += 1) {
      while (excess[index] > 0 && text[end - 1] === pairs[index][1]) {
        if (++inspected % 4096 === 0) await yieldExecution(undefined, { signal });
        end -= 1;
        excess[index] -= 1;
      }
    }
    text = text.slice(0, end);
    try {
      const url = new URL(text);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) links.push(url.href);
    } catch {
      // An invalid URL in prose is data, not a command or a replacement task.
    }
  }
  signal.throwIfAborted();
  if (links.length === 0) throw new NativeInputError('NO_LINKS');
  let result = options.deduplicate ? [...new Set(links)] : links;
  if (options.sort) result = [...result].sort();
  const count = result.length;
  result = result.slice(0, options.maxItems);
  const english = options.language === 'en';
  const limited = count > result.length
    ? english ? `; limit exceeded; showing the first ${result.length}` : `；超过上限，展示前 ${result.length} 条`
    : '';
  const heading = english ? `Organized result: ${result.length} link${result.length === 1 ? '' : 's'}`
    : `整理结果：${result.length} 条链接`;
  signal.throwIfAborted();
  return `${heading}${limited}\n\n${result.map((url, index) => `${index + 1}. ${url}`).join('\n')}`;
}
