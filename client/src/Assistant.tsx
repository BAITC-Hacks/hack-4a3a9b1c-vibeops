import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AssistantBrief, AssistantDraft } from '../../shared/assistant';
import type { Query } from '../../shared/contracts';
import { prepareBrief } from './api';

const EXAMPLE = 'Нужен ведущий на корпоратив в Алматы 10 октября 2026, до 1 миллиона тенге, на русском, на 5 часов. Хочу интеллигентный юмор, танцы и программу без долгих речей.';
const LABELS: [keyof AssistantDraft, string][] = [
  ['city', 'Город'], ['category', 'Подрядчик'], ['event_format', 'Мероприятие'],
  ['date', 'Дата'], ['budget_kzt', 'Бюджет на подрядчика'], ['language', 'Язык'], ['hours', 'Длительность'],
];
const display = (key: keyof AssistantDraft, value: AssistantDraft[keyof AssistantDraft]) => {
  if (value === null) return key === 'hours' || key === 'language' ? 'Не указан · необязательно' : 'Нужно уточнить';
  if (key === 'budget_kzt') return `до ${new Intl.NumberFormat('ru-RU').format(Number(value))} ₸`;
  if (key === 'hours') return `${value} ч`;
  if (key === 'date') {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return String(value);
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  }
  return String(value);
};

export default function Assistant({ onActivity, onConfirm, onManualSearch, canSearch, externalRevision }: {
  onActivity: (reason: 'edit' | 'reset') => void;
  onConfirm: (query: Query, preferences: string[]) => void;
  onManualSearch: () => void;
  canSearch: boolean;
  externalRevision: number;
}) {
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [brief, setBrief] = useState<AssistantBrief | null>(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [manuallyChanged, setManuallyChanged] = useState(false);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => () => { sequence.current += 1; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!externalRevision) return;
    sequence.current += 1; controller.current?.abort();
    setManuallyChanged(previous => previous || !!(brief || messages.length || pending || prompt));
    setPending(''); setMessages([]); setPrompt(''); setBrief(null); setError(''); setConfirmed(false);
  }, [externalRevision]);

  const cancel = () => { sequence.current += 1; controller.current?.abort(); setPending(''); };
  const reset = () => {
    cancel(); setMessages([]); setPrompt(''); setBrief(null); setError(''); setConfirmed(false); setManuallyChanged(false); onActivity('reset'); input.current?.focus();
  };
  const edit = (value: string) => {
    if (pending) cancel();
    setPrompt(value); setError(''); setConfirmed(false); setManuallyChanged(false); onActivity('edit');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || pending) return;
    const next = [...messages, message];
    if (next.length > 8 || next.reduce((length, item) => length + item.length, 0) > 8000) {
      setError('Достигнут предел диалога. Начните новый запрос и соберите актуальные условия в одном сообщении.'); return;
    }
    cancel(); onActivity('edit'); setError(''); setConfirmed(false); setPending(message);
    const requestId = ++sequence.current;
    const abort = new AbortController(); controller.current = abort;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
    try {
      const response = await prepareBrief(next, abort.signal);
      if (requestId !== sequence.current) return;
      setBrief(response); setMessages(next); setPrompt('');
    } catch (failure) {
      if (requestId !== sequence.current) return;
      setError(timedOut ? 'AI не ответил за 15 секунд. Отправьте запрос ещё раз.' : failure instanceof Error ? failure.message : 'AI не смог разобрать запрос. Попробуйте ещё раз.');
    } finally {
      window.clearTimeout(timer);
      if (requestId === sequence.current) setPending('');
    }
  };

  return <section className="assistant" aria-labelledby="assistant-title">
    <div className="assistant-conversation">
      <div className="assistant-heading"><span className="assistant-mark" aria-hidden="true">✳</span><div><p className="eyebrow">Начните с вашей идеи</p><h2 id="assistant-title">Расскажите AI о событии</h2></div><span className="assistant-badge">AI-помощник</span></div>
      <p className="assistant-description">Опишите, что нужно для события и что для вас важно. Помощник соберёт условия и задаст вопросы. После подбора AI сравнит пожелания с описаниями выбранных кандидатов; пожелания не меняют их состав и порядок.</p>
      {manuallyChanged && <p className="assistant-context-note" role="status">Условия изменены в форме ниже. Предыдущий диалог сброшен, чтобы не вернуть старые параметры. Подбор можно продолжить через форму или описать новое событие здесь.</p>}
      {messages.length > 0 && <div className="assistant-history" aria-label="Ваши сообщения">{messages.map((message, index) => <div className="assistant-message" key={index}><span>{index === 0 ? 'Ваш запрос' : `Уточнение ${index}`}</span><p>{message}</p></div>)}</div>}
      <form onSubmit={event => void submit(event)} className="assistant-form">
        <label htmlFor="assistant-prompt">{messages.length ? 'Уточните или измените условия' : 'Какое событие планируете?'}</label>
        <textarea id="assistant-prompt" ref={input} rows={4} maxLength={2000} value={prompt} onChange={event => edit(event.target.value)} placeholder="Например: ищу ведущего для корпоратива в Алматы. Важно, чтобы были интерактивы и живая музыка…" aria-describedby="assistant-hint" />
        <div className="assistant-input-meta"><span id="assistant-hint">{messages.length ? `${messages.length} из 8 сообщений · учитываем предыдущие условия` : 'Можно своими словами — на русском или казахском'}</span><span>{prompt.length}/2000</span></div>
        {!messages.length && !pending && <button type="button" className="assistant-example" onClick={() => { edit(EXAMPLE); input.current?.focus(); }}><span aria-hidden="true">↗</span> Попробовать пример с корпоративом</button>}
        <div className="assistant-actions"><button type="submit" className="primary assistant-submit" disabled={!prompt.trim() || !!pending || messages.length >= 8}>{pending ? 'AI разбирает запрос…' : messages.length ? 'Отправить уточнение' : 'Собрать условия с AI'}<span aria-hidden="true">↗</span></button>
          {pending ? <button type="button" className="assistant-reset" onClick={cancel}>Отменить</button> : (messages.length > 0 || error) && <button type="button" className="assistant-reset" onClick={reset}>Новый запрос</button>}
        </div>
      </form>
      {error && <div className="error-box" role="alert"><strong>AI не подготовил условия</strong><p>{error}</p><p>Можно повторить запрос или воспользоваться формой ниже.</p><button type="button" className="secondary" onClick={onManualSearch}>Перейти к ручному подбору</button></div>}
    </div>
    <div className="assistant-review" aria-live="polite" aria-busy={!!pending}>
      {pending ? <div className="assistant-thinking" role="status"><span className="spinner" aria-hidden="true" /><h3>Разбираем вашу идею</h3><p>Выделяем условия и пожелания, проверяем, что нужно уточнить.</p></div> : brief ? <>
        <div className="brief-heading"><span className="eyebrow">AI понял запрос так</span><span className={`brief-state ${brief.query ? 'ready' : ''}`}>{brief.query ? 'Можно подбирать' : 'Нужно уточнение'}</span></div>
        <h3 className="brief-summary">{brief.summary}</h3>
        <dl className="brief-fields">{LABELS.map(([key, label]) => <div key={key} className={brief.draft[key] === null && key !== 'hours' && key !== 'language' ? 'missing' : ''}><dt>{label}</dt><dd>{display(key, brief.draft[key])}</dd></div>)}</dl>
        {brief.preferences.length > 0 && <div className="brief-preferences"><h4>Что ещё важно для вас</h4><div>{brief.preferences.map((preference, index) => <span key={index}>{preference}</span>)}</div><p>После подбора AI найдёт основания в описаниях и выделит то, что нужно уточнить.</p></div>}
        {brief.questions.length > 0 && <div className="brief-questions"><h4>Уточним перед подбором</h4><ul>{brief.questions.map((question, index) => <li key={index}>{question}</li>)}</ul><p>Ответьте в поле сообщения — помощник дополнит условия.</p></div>}
        {brief.warnings.length > 0 && <div className="brief-warnings" role="note" aria-label="Что проверить перед подбором"><strong>Проверьте перед подбором</strong>{brief.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        <button type="button" className="primary brief-confirm" disabled={!brief.query || !canSearch || !!prompt.trim()} onClick={() => { if (brief.query) { setConfirmed(true); onConfirm(brief.query, brief.preferences); } }}>Подобрать по этим условиям<span aria-hidden="true">↓</span></button>
        <p className="brief-footnote">{confirmed ? 'Условия перенесены в форму. Результат подбора — ниже.' : prompt.trim() ? 'Сначала отправьте уточнение, чтобы обновить условия.' : !brief.query ? 'Заполните недостающие условия в следующем сообщении.' : !canSearch ? 'Дождитесь загрузки каталога или завершения текущего подбора.' : 'Проверьте условия перед подбором. Их также можно изменить в форме ниже.'}</p>
      </> : <div className="assistant-guide"><span className="assistant-guide-orbit" aria-hidden="true">✳</span><h3>От идеи — к трём кандидатам</h3><ol><li><span>01</span><div><strong>Расскажите о событии</strong><p>Город, дата, бюджет и атмосфера, которую вы хотите создать.</p></div></li><li><span>02</span><div><strong>Уточните вместе с AI</strong><p>Помощник спросит о недостающем. Вы проверите готовые условия.</p></div></li><li><span>03</span><div><strong>Выберите осознанно</strong><p>Сравните кандидатов по пожеланиям и узнайте, что ещё обсудить.</p></div></li></ol></div>}
    </div>
  </section>;
}
