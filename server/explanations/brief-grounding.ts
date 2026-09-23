/** Server-owned arithmetic. Message strings remain data; nothing here executes model instructions. */
export const BRIEF_TIME_ZONE = 'Asia/Almaty';
export function todayInAlmaty(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: BRIEF_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function relativeDates(text: string, today: string): Set<string> {
  const dates = new Set<string>();
  const add = (days: number) => {
    if (!Number.isSafeInteger(days) || days < 0 || days > 3660) return;
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    dates.add(date.toISOString().slice(0, 10));
  };
  const textLower = text.toLowerCase();
  const negated = (index: number) => /(?:^|[\s,;])не\s*$/u.test(textLower.slice(0, index));
  const words: Record<string, number> = { сегодня: 0, завтра: 1, послезавтра: 2, бүгін: 0, ертең: 1, бүрсігүні: 2 };
  for (const match of textLower.matchAll(/(?<!\p{L})(сегодня|завтра|послезавтра|бүгін|ертең|бүрсігүні)(?!\p{L})/gu)) if (!negated(match.index!)) add(words[match[1]!]!);
  const numbers: Record<string, number> = { один: 1, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, неделю: 7, бір: 1, екі: 2, үш: 3 };
  for (const match of textLower.matchAll(/(?<!\p{L})через\s+(\d{1,4}|один|два|три|четыре|пять|шесть|семь)\s+(?:день|дня|дней|сутки|суток)(?!\p{L})/gu)) if (!negated(match.index!)) add(numbers[match[1]!] ?? Number(match[1]));
  for (const match of textLower.matchAll(/(?<!\p{L})через\s+(?:(\d{1,3}|одну|две|три|четыре)\s+)?недел(?:ю|и|ь)(?!\p{L})/gu)) {
    const weeks = ({ одну: 1, две: 2, три: 3, четыре: 4 } as Record<string, number>)[match[1] ?? 'одну'] ?? Number(match[1]);
    if (!negated(match.index!)) add(weeks * 7);
  }
  for (const match of text.toLowerCase().matchAll(/(?<![\p{L}\d])(\d{1,4}|бір|екі|үш)\s+күннен\s+кейін(?!\p{L})/gu)) if (!negated(match.index!)) add(numbers[match[1]!] ?? Number(match[1]));
  const weekdays: Record<string, number> = { понедельник: 1, вторник: 2, среда: 3, среду: 3, четверг: 4, пятница: 5, пятницу: 5, суббота: 6, субботу: 6, воскресенье: 0 };
  const dayOfWeek = new Date(`${today}T12:00:00Z`).getUTCDay();
  for (const match of textLower.matchAll(/(?<!\p{L})(?:(?:в|на)\s+)?(?:(следующ(?:ий|ую|ее)|эт(?:у|от)|ближайш(?:ий|ую))\s+)?(понедельник|вторник|среда|среду|четверг|пятница|пятницу|суббота|субботу|воскресенье)(?!\p{L})/gu)) {
    if (negated(match.index!)) continue;
    const target = weekdays[match[2]!]!;
    const days = match[1]?.startsWith('следующ') ? 7 - (dayOfWeek + 6) % 7 + (target + 6) % 7 : (target - dayOfWeek + 7) % 7;
    add(days);
  }
  const monthNames = ['январ(?:ь|я)|қаңтар', 'феврал(?:ь|я)|ақпан', 'март(?:а)?|наурыз', 'апрел(?:ь|я)|сәуір', 'ма[йя]|мамыр', 'июн(?:ь|я)|маусым', 'июл(?:ь|я)|шілде', 'август(?:а)?|тамыз', 'сентябр(?:ь|я)|қыркүйек', 'октябр(?:ь|я)|қазан', 'ноябр(?:ь|я)|қараша', 'декабр(?:ь|я)|желтоқсан'];
  monthNames.forEach((month, index) => {
    const expression = new RegExp(`(?<![\\d\\p{L}])(\\d{1,2})\\s+(?:${month})(?:да|де|нда|нде)?(?!\\p{L})(?!\\s+\\d{4})`, 'gu');
    for (const match of textLower.matchAll(expression)) {
      if (negated(match.index!) || /\d{4}\s*(?:жылғы|жыл|ж\.)?\s*$/u.test(textLower.slice(0, match.index!))) continue;
      let year = Number(today.slice(0, 4));
      const suffix = `${String(index + 1).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
      if (`${year}-${suffix}` < today) year++;
      dates.add(`${year}-${suffix}`);
    }
  });
  return dates;
}

/** “This Friday” after Friday is not silently shifted into the following week. */
export function isPastThisWeekday(text: string, today: string): boolean {
  const weekdays: Record<string, number> = { понедельник: 0, вторник: 1, среда: 2, среду: 2, четверг: 3, пятница: 4, пятницу: 4, суббота: 5, субботу: 5, воскресенье: 6 };
  const current = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  for (const match of text.toLowerCase().matchAll(/(?<!\p{L})эт(?:у|от|о)\s+(понедельник|вторник|среда|среду|четверг|пятница|пятницу|суббота|субботу|воскресенье)(?!\p{L})/gu)) {
    if (weekdays[match[1]!]! < current) return true;
  }
  return false;
}

export type MoneyCurrency = 'KZT' | 'USD' | 'EUR' | 'RUB';
export type MoneyMention = { amount: number; currency: MoneyCurrency; quote: string; index: number; end: number; notTotal: boolean };
const digitNumber = '-?\\d+(?:[ \\u00a0\\u202f]\\d{3})*(?:[.,]\\d+)?';
const numberWords: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
  тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
  пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500,
  шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
};
const scales: Record<string, number> = { тысяча: 1000, тысячи: 1000, тысяч: 1000, миллион: 1000000, миллиона: 1000000, миллионов: 1000000 };
const wordToken = `(?:${[...Object.keys(numberWords), ...Object.keys(scales), 'полмиллиона', 'полтысячи'].sort((a, b) => b.length - a.length).join('|')})(?!\\p{L})`;
const wordNumber = `${wordToken}(?:\\s+${wordToken})*`;
const number = `(?:${digitNumber}|${wordNumber})`;
const unit = '(?:тыс(?:яч[аиу]?)?\\.?|тысяча|млн\\.?|миллион(?:а|ов)?|мың|[кk])';
const currency = '(?:тенге|теңге|kzt|тг\\.?|₸|usd|доллар(?:а|ов)?|доллар[ы]?|\\$|eur|евро|€|rub|рубл(?:ь|я|ей)|₽)';
function moneyCurrency(text: string): MoneyCurrency {
  if (/usd|доллар|\$/iu.test(text)) return 'USD';
  if (/eur|евро|€/iu.test(text)) return 'EUR';
  if (/rub|рубл|₽/iu.test(text)) return 'RUB';
  return 'KZT';
}
function amountOf(value: string, scale = ''): number {
  const multiplier = /^(?:млн|миллион)/iu.test(scale) ? 1_000_000 : scale ? 1000 : 1;
  if (/^-?\d/u.test(value)) return Number(value.replace(/[ \u00a0\u202f]/gu, '').replace(',', '.')) * multiplier;
  if (value === 'полмиллиона') return 500000 * multiplier;
  if (value === 'полтысячи') return 500 * multiplier;
  let total = 0, group = 0, lastValue = Infinity, lastScale = Infinity;
  const tokens = value.split(/\s+/u);
  for (const token of tokens) {
    const factor = scales[token];
    if (factor) {
      if (factor >= lastScale) return NaN;
      total += (group || 1) * factor;
      group = 0; lastValue = Infinity; lastScale = factor;
    } else {
      const part = numberWords[token];
      if (part === undefined || part >= lastValue || (lastValue >= 10 && lastValue < 20)
        || (lastValue < 100 && part >= 10) || (part === 0 && tokens.length > 1)) return NaN;
      group += part; lastValue = part;
    }
  }
  return (total + group) * multiplier;
}

/** Only explicit currencies or a nearby budget label ground an amount; a guest count never does. */
export function moneyMentions(input: string): MoneyMention[] {
  const text = input.toLowerCase();
  const found: MoneyMention[] = [];
  const put = (match: RegExpMatchArray, amount: string, scale: string | undefined, denomination: string) => {
    const index = match.index!;
    const end = index + match[0].length;
    const context = text.slice(Math.max(0, index - 24), Math.min(text.length, end + 30));
    const after = text.slice(end, end + 30);
    const before = text.slice(Math.max(0, index - 35), index);
    const notTotal = /^(?:\s*[,;]?\s*)(?:в|за|на|\/)?\s*(?:час(?:а|ов)?|ч\b|гост[ьяей]+|человек[а]?|персон[уы]?)(?!\p{L})/u.test(after)
      || /(?:бюджет\s*(?:не\s+меньше|минимум|от)|не\s+менее|от|\d\s*[-–—])\s*$/u.test(before)
      || new RegExp(`^\\s*(?:[-–—]|до|или)\\s*(?:${number})(?!\\p{L})`, 'u').test(after)
      || /(?:^|\s)не\s*$/u.test(before);
    // Number + currency is unambiguous. A budget-prefixed guest count is not.
    if (/^\s*(?:гост|человек|час|дн[яе]|сут|gbp|cny|aed|фунт|юан|дирхам|£|¥|долл\b)/u.test(after) && denomination === '') return;
    if (found.some(item => item.index <= end && item.end >= index)) return;
    const parsed = amountOf(amount, scale);
    if (!Number.isFinite(parsed)) return;
    found.push({ amount: parsed, currency: moneyCurrency(denomination), quote: input.slice(index, end), index, end, notTotal: notTotal || /(?:на\s+каждого|с\s+человека)/u.test(context) });
  };
  for (const match of text.matchAll(new RegExp(`(?<![\\d\\p{L}])(${number})\\s*(${unit})?\\s*(${currency})(?!\\p{L})`, 'gu'))) put(match, match[1]!, match[2], match[3]!);
  for (const match of text.matchAll(new RegExp(`(?<!\\p{L})(${currency})\\s*(${number})\\s*(${unit})?(?!\\p{L})`, 'gu'))) put(match, match[2]!, match[3], match[1]!);
  for (const match of text.matchAll(new RegExp(`(?<!\\p{L})(?:бюджет(?:ом)?|бюджетім|бюджеті|максимум|потолок)\\s*[:—–=-]?\\s*(?:(?:до|на)\\s+)?(${number})\\s*(${unit})?(?![\\p{L}\\d])`, 'gu'))) put(match, match[1]!, match[2], '');
  // A standalone scaled amount is a usable short budget answer. Bare counts
  // ("сто", "пять") still require a budget label or explicit currency.
  const short = new RegExp(`^\\s*(?:до\\s+)?(${number})\\s*(${unit})?\\s*[.!]?\\s*$`, 'u').exec(text);
  if (short && (short[2] || /тысяч|миллион/u.test(short[1]!))) put(short, short[1]!, short[2], '');
  return found.sort((left, right) => left.index - right.index);
}
