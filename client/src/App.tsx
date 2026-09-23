import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Card, Query, Reason, RecommendResponse } from '../../shared/contracts';
import type { AssistantComparison } from '../../shared/assistant';
import { comparePreferences, getOptions, recommend, RequestError } from './api';
import type { CatalogOptions } from './api';
import { DEMOS } from './demo';
import Assistant from './Assistant';
import DecisionSupport from './DecisionSupport';

type FormValues = { city: string; date: string; event_format: string; category: string; budget_kzt: string; hours: string; language: string };
const INITIAL: FormValues = { city: '', date: '2026-10-10', event_format: '', category: '', budget_kzt: '1000000', hours: '', language: '' };
const REASONS: Record<Reason, string> = {
  busy_date: 'Заняты на выбранную дату', over_budget: 'Стартовая цена выше бюджета',
  unsupported_format: 'Не работают с этим форматом', unsupported_language: 'Не указан нужный язык',
  insufficient_hours: 'Длительность превышает максимум',
};
const money = (amount: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(amount);
const dateLabel = (date: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const fromQuery = (query: Query): FormValues => ({
  ...query, budget_kzt: String(query.budget_kzt), hours: query.hours == null ? '' : String(query.hours), language: query.language ?? '',
});

function validate(values: FormValues, options: CatalogOptions): { query: Query | null; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (!options.cities.includes(values.city)) fields.city = 'Выберите город.';
  if (!values.category.trim()) fields.category = 'Выберите категорию.';
  if (!options.event_formats.includes(values.event_format)) fields.event_format = 'Выберите формат.';
  const date = new Date(`${values.date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== values.date) {
    fields.date = 'Введите существующую дату.';
  } else if (values.date < options.date_min || values.date > options.date_max) {
    fields.date = `Данные доступны с ${dateLabel(options.date_min)} по ${dateLabel(options.date_max)}.`;
  }
  const budget = Number(values.budget_kzt);
  if (!values.budget_kzt.trim() || !Number.isSafeInteger(budget) || budget < 0) fields.budget_kzt = 'Введите целое число от 0 в тенге.';
  const hours = values.hours.trim() ? Number(values.hours) : null;
  if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) fields.hours = 'Длительность должна быть больше нуля.';
  if (values.language && !options.languages.includes(values.language)) fields.language = 'Выберите язык из списка.';
  return {
    fields, query: Object.keys(fields).length ? null : {
      city: values.city, date: values.date, category: values.category, event_format: values.event_format,
      budget_kzt: budget, hours, language: values.language || null,
    },
  };
}

function VendorCard({ card, index, comparison }: { card: Card; index: number; comparison?: AssistantComparison['items'][number] }) {
  return <article className="vendor-card" aria-labelledby={`vendor-${card.id}`}>
    <div className="card-top"><span className="card-category">{card.category}</span><span className="card-index">0{index + 1}</span></div>
    <h3 id={`vendor-${card.id}`}>{card.name}</h3>
    <p className="card-city">{card.city}</p>
    <p className="price"><span>от </span>{money(card.price_from_kzt)} <span>₸</span></p>
    <p className="price-caption">за мероприятие · итоговую стоимость нужно уточнить</p>
    <div className="explanation-block"><h4>Почему в подборке</h4><p>{card.explanation}</p></div>
    {comparison && <div className="preference-evidence"><h4>Под ваши пожелания</h4>
      {comparison.evidence.map((item, evidenceIndex) => <div className="preference-match" key={evidenceIndex}><strong>{item.preference}</strong><blockquote>«{item.quote}»</blockquote></div>)}
      {comparison.to_confirm.length > 0 && <div className="preference-unknown"><h5>Нужно уточнить у подрядчика</h5><ul>{comparison.to_confirm.map((preference, preferenceIndex) => <li key={preferenceIndex}>{preference}</li>)}</ul><p>В описании не найдено достаточного основания.</p></div>}
    </div>}
    <div className="facts">
      <span>{card.languages.join(' / ')}</span>
      <span>{card.max_hours === null ? 'Присутствие по часам не применимо' : `До ${card.max_hours} ч на площадке`}</span>
    </div>
    <div className="provenance">
      <span className={card.synthetic ? 'badge synthetic' : 'badge'}>{card.synthetic ? 'Синтетический профиль' : 'Анонимизированный профиль'}</span>
      {card.price_imputed && <span className="badge estimate">Цена проставлена в датасете</span>}
      {card.city_imputed && <span className="badge estimate">Город проставлен в датасете</span>}
    </div>
    <details className="evidence"><summary>Основание объяснения</summary>
      <p>{card.explanation_source === 'llm' ? 'Фрагмент описания выбран AI и проверен сервером.' : 'Объяснение собрано из данных каталога без AI.'}</p>
      {card.evidence_quote ? <blockquote>{card.evidence_quote}</blockquote> : <p>Отдельная цитата не выбрана.</p>}
      <p className="muted">Сведения из описания подрядчика не являются независимой проверкой его опыта. ID: {card.id}</p>
    </details>
  </article>;
}

function Results({ result, comparison, comparisonLoading, comparisonError, retryComparison, applyAlternative }: {
  result: RecommendResponse; comparison: AssistantComparison | null; comparisonLoading: boolean; comparisonError: string; retryComparison: () => void;
  applyAlternative: (query: Query) => void;
}) {
  const { outcome, summary, query, explanation } = result;
  const title = outcome === 'matched' ? 'Ваша подборка' : outcome === 'no_category_in_city' ? 'В этом городе такой категории нет' : 'Никто не проходит по условиям';
  const busy = summary.rejected.filter(item => item.reasons.includes('busy_date'));
  const reasons = Object.entries(REASONS) as [Reason, string][];
  return <section className="results" aria-labelledby="result-title">
    <div className="results-heading"><div><p className="eyebrow">Результат подбора</p><h2 id="result-title">{title}</h2></div>
      <span className="result-number">{result.cards.length} / 3</span></div>
    <p className="query-summary">{query.city} · {query.category} · {query.event_format} · {dateLabel(query.date)} · до {money(query.budget_kzt)} ₸{query.language ? ` · ${query.language}` : ''}{query.hours !== null ? ` · ${query.hours} ч` : ''}</p>
    <p className="result-message" role="status">{summary.message}</p>
    {(explanation.mode === 'fallback' || explanation.mode === 'mixed' || explanation.warning) &&
      <div className="notice" role="status"><strong>{explanation.mode === 'mixed' ? 'Часть объяснений подготовлена без AI.' : explanation.mode === 'fallback' ? 'Объяснения подготовлены без AI.' : 'Примечание к объяснениям.'}</strong>{' '}{explanation.warning || 'Показаны факты и фрагменты описаний из каталога.'}</div>}
    {comparisonLoading && <div className="comparison-progress" role="status"><span className="spinner" aria-hidden="true" /><div><strong>AI сопоставляет ваши пожелания</strong><p>Подрядчики уже подобраны. Проверяем, что об их подходе сказано в описаниях.</p></div></div>}
    {comparisonError && <div className="error-box" role="alert"><strong>AI-сравнение пока недоступно</strong><p>{comparisonError}</p><p>Подбор по дате, бюджету и остальным условиям сохранён.</p><button type="button" className="secondary" onClick={retryComparison}>Повторить AI-сравнение</button></div>}
    {comparison?.items.length ? <div className="comparison-caption"><span aria-hidden="true">✳</span><p><strong>AI разобрал описания под ваш запрос.</strong> Цитаты ниже — основания для интерпретации AI. Это сведения из профилей, а не гарантия соответствия пожеланиям.</p></div> : null}
    {outcome === 'matched' ? <>
      <div className="cards">{result.cards.map((card, index) => <VendorCard key={card.id} card={card} index={index} comparison={comparison?.items.find(item => item.id === card.id)} />)}</div>
      <p className="availability-note">На выбранную дату эти подрядчики не отмечены занятыми в каталоге. Это не подтверждение бронирования. Стартовая цена не превышает указанный бюджет.</p>
    </> : <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">{outcome === 'no_category_in_city' ? '∅' : '—'}</span>
      <div><h3>{outcome === 'no_category_in_city' ? 'Каталог пока не покрывает этот выбор' : 'Можно изменить параметры поиска'}</h3>
        <p>{outcome === 'no_category_in_city' ? 'Попробуйте другую категорию или город. Мы не подставляем подрядчиков из другого города автоматически.' : 'Посмотрите причины ниже и измените дату, бюджет или другие условия в форме.'}</p></div>
    </div>}
    <DecisionSupport support={result.decision_support} cards={result.cards} onApply={applyAlternative} />
    {summary.base_count > 0 && <section className="diagnostics" aria-labelledby="diagnostics-title">
      <div className="diagnostics-heading"><h3 id="diagnostics-title">Что повлияло на подбор</h3><span>{summary.base_count} в каталоге · {summary.eligible_count} подходят · {summary.rejected_count} исключены</span></div>
      {summary.rejected_count > 0 ? <>
        <div className="reason-counts">{reasons.filter(([key]) => summary.rejection_counts[key] > 0).map(([key, label]) =>
          <div key={key}><span>{label}</span><strong>{summary.rejection_counts[key]}</strong></div>)}</div>
        <p className="muted">У одного подрядчика может быть несколько причин отказа. Счётчики причин не складываются в число исключённых профилей.</p>
        {busy.length > 0 && <p className="busy-note"><strong>Заняты {dateLabel(query.date)}:</strong> {busy.map(item => item.anon_name).join(', ')}.</p>}
        <details><summary>Причины по каждому исключённому подрядчику</summary><ul className="rejected-list">
          {summary.rejected.map(item => <li key={item.id}><strong>{item.anon_name}</strong><span>{item.reasons.map(reason => REASONS[reason]).join('; ')}</span></li>)}
        </ul></details>
      </> : <p className="muted">Все профили этой категории в выбранном городе проходят заданные условия.</p>}
    </section>}
    <details className="technical"><summary>Как получен результат</summary>
      <p>Каталог → проверка условий → стабильное ранжирование → до трёх карточек → объяснения.</p>
      <dl><dt>Режим объяснений</dt><dd>{({ llm: 'AI', fallback: 'Без AI', mixed: 'Смешанный', not_needed: 'Объяснения не требуются' })[explanation.mode]}</dd>
        {explanation.model && <><dt>Модель</dt><dd>{explanation.model}</dd></>}
        <dt>Кэш объяснений</dt><dd>{explanation.cached ? 'Использован' : 'Не использован'}</dd>
        <dt>Время обработки на сервере</dt><dd>{(result.meta.elapsed_ms / 1000).toFixed(2)} с</dd>
        <dt>Версия ранжирования</dt><dd>{result.meta.ranking_version}</dd>
        <dt>SHA-256 каталога</dt><dd className="hash">{result.meta.dataset_sha256}</dd></dl>
    </details>
  </section>;
}

export default function App() {
  const [options, setOptions] = useState<CatalogOptions | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [values, setValues] = useState<FormValues>(INITIAL);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [result, setResult] = useState<RecommendResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeDemo, setActiveDemo] = useState<string | null>(null);
  const [activePreferences, setActivePreferences] = useState<string[]>([]);
  const [assistantRevision, setAssistantRevision] = useState(0);
  const [comparison, setComparison] = useState<AssistantComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState('');
  const [comparisonRequest, setComparisonRequest] = useState<{ query: Query; preferences: string[]; cards: Card[] } | null>(null);
  const comparisonController = useRef<AbortController | null>(null);
  const comparisonSequence = useRef(0);
  const workspace = useRef<HTMLDivElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 15_000);
    let disposed = false;
    setOptionsError('');
    getOptions(abort.signal).then(data => {
      if (disposed) return;
      setOptions(data);
      const preferred = (list: string[], choice: string) => list.includes(choice) ? choice : list[0] ?? '';
      setValues(previous => ({ ...previous, city: preferred(data.cities, 'Алматы'), category: preferred(data.categories, 'Ведущий'), event_format: preferred(data.event_formats, 'корпоратив'), date: previous.date >= data.date_min && previous.date <= data.date_max ? previous.date : data.date_min }));
    }).catch(failure => {
      if (disposed) return;
      setOptionsError(abort.signal.aborted ? 'Каталог не ответил вовремя. Попробуйте загрузить его ещё раз.' : failure instanceof Error ? failure.message : 'Не удалось загрузить каталог.');
    }).finally(() => window.clearTimeout(timer));
    return () => { disposed = true; window.clearTimeout(timer); abort.abort(); };
  }, [optionsAttempt]);

  useEffect(() => () => { sequence.current += 1; controller.current?.abort(); comparisonSequence.current += 1; comparisonController.current?.abort(); }, []);

  const invalidate = () => {
    sequence.current += 1;
    controller.current?.abort();
    comparisonSequence.current += 1; comparisonController.current?.abort();
    setComparison(null); setComparisonError(''); setComparisonLoading(false); setComparisonRequest(null);
    setLoading(false); setResult(null); setError(''); setFields({});
  };
  const change = (key: keyof FormValues, value: string) => {
    invalidate(); setAssistantRevision(revision => revision + 1); setActiveDemo(null); setValues(previous => ({ ...previous, [key]: value }));
  };
  const runComparison = async (query: Query, preferences: string[], cards: Card[]) => {
    comparisonController.current?.abort();
    const requestId = ++comparisonSequence.current;
    const abort = new AbortController(); comparisonController.current = abort;
    setComparisonLoading(true); setComparisonError(''); setComparison(null);
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
    try {
      const response = await comparePreferences(query, preferences, abort.signal);
      if (requestId !== comparisonSequence.current) return;
      if (response.items.length !== cards.length || response.items.some(item => !cards.some(card => card.id === item.id && card.name === item.name))) {
        throw new RequestError('AI вернул сравнение для других профилей. Повторите сравнение.');
      }
      setComparison(response);
    } catch (failure) {
      if (requestId !== comparisonSequence.current) return;
      setComparisonError(timedOut ? 'AI не ответил за 15 секунд.' : failure instanceof Error ? failure.message : 'Не удалось сравнить пожелания.');
    } finally {
      window.clearTimeout(timer);
      if (requestId === comparisonSequence.current) setComparisonLoading(false);
    }
  };
  const run = async (form: FormValues, preferences?: string[]) => {
    if (!options) return;
    invalidate();
    const validation = validate(form, options);
    setFields(validation.fields);
    if (!validation.query) { setError('Проверьте отмеченные поля.'); return; }
    const requestId = ++sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
    setLoading(true);
    try {
      const response = await recommend(validation.query, abort.signal);
      if (sequence.current === requestId) {
        setResult(response);
        if (preferences?.length && response.cards.length) {
          setComparisonRequest({ query: validation.query, preferences, cards: response.cards });
          void runComparison(validation.query, preferences, response.cards);
        }
      }
    } catch (failure) {
      if (sequence.current !== requestId) return;
      if (timedOut) setError('Сервер не ответил за 15 секунд. Попробуйте повторить подбор. Это ошибка соединения, а не отсутствие кандидатов.');
      else if (failure instanceof RequestError) { setError(failure.message); setFields(failure.fields); }
      else if (!(failure instanceof Error && failure.name === 'AbortError')) setError('Не удалось выполнить подбор. Попробуйте ещё раз.');
    } finally {
      window.clearTimeout(timer);
      if (sequence.current === requestId) setLoading(false);
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); setAssistantRevision(revision => revision + 1); void run(values, activePreferences); };
  const fieldError = (key: keyof FormValues) => fields[key] ? <span className="field-error" id={`${key}-error`}>{fields[key]}</span> : null;
  const attributes = (key: keyof FormValues) => ({ id: key, name: key, 'aria-invalid': !!fields[key], 'aria-describedby': fields[key] ? `${key}-error` : undefined });

  return <>
    <header className="site-header"><div className="header-inner"><a className="brand" href="#main"><span className="brand-mark" aria-hidden="true">f.</span>firebird<span className="brand-separator">/</span><span className="brand-description">подрядчики для событий</span></a><span className="team-label">VibeOps · HackAlem AI</span></div></header>
    <main id="main">
      <section className="intro"><p className="eyebrow">Ваше событие начинается с разговора</p><h1>Есть идея события.<br /><span>Найдём, с кем её воплотить.</span></h1><p className="intro-text">AI превратит ваше описание в условия подбора и поможет сравнить до трёх подрядчиков по тому, что важно именно вам.</p></section>
      <Assistant externalRevision={assistantRevision} canSearch={!!options && !loading} onActivity={reason => { invalidate(); setActiveDemo(null); if (reason === 'reset') setActivePreferences([]); }} onConfirm={(query, preferences) => { const form = fromQuery(query); setValues(form); setActiveDemo(null); setActivePreferences(preferences); void run(form, preferences); workspace.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }} />
      <div className="workspace" ref={workspace}>
        <aside className="search-panel" aria-labelledby="search-title"><div className="panel-title"><span className="step">↙</span><h2 id="search-title">Ваше мероприятие</h2></div><p className="manual-hint">Можно задать условия вручную или изменить подготовленные AI.</p>
          {optionsError ? <div className="error-box" role="alert"><p>{optionsError}</p><button className="secondary" onClick={() => setOptionsAttempt(value => value + 1)}>Загрузить каталог снова</button></div> : !options ? <p className="catalog-loading" role="status">Загружаем параметры каталога…</p> : null}
          <form onSubmit={submit} noValidate>
            <fieldset disabled={!options}><legend className="sr-only">Параметры подбора</legend>
              <label htmlFor="city">Город</label><select {...attributes('city')} value={values.city} onChange={event => change('city', event.target.value)}><option value="" disabled>Выберите город</option>{options?.cities.map(value => <option key={value}>{value}</option>)}</select>{fieldError('city')}
              <label htmlFor="event_format">Формат мероприятия</label><select {...attributes('event_format')} value={values.event_format} onChange={event => change('event_format', event.target.value)}><option value="" disabled>Выберите формат</option>{options?.event_formats.map(value => <option key={value}>{value}</option>)}</select>{fieldError('event_format')}
              <label htmlFor="category">Кого ищем</label><select {...attributes('category')} value={values.category} onChange={event => change('category', event.target.value)}><option value="" disabled>Выберите категорию</option>{values.category && options && !options.categories.includes(values.category) && <option value={values.category}>{values.category} · нет в каталоге</option>}{options?.categories.map(value => <option key={value}>{value}</option>)}</select>{fieldError('category')}
              <div className="form-row"><div><label htmlFor="date">Дата</label><input {...attributes('date')} type="date" min={options?.date_min} max={options?.date_max} value={values.date} onChange={event => change('date', event.target.value)} />{fieldError('date')}</div><div><label htmlFor="budget_kzt">Бюджет, ₸</label><input {...attributes('budget_kzt')} type="number" min="0" step="1" inputMode="numeric" value={values.budget_kzt} onChange={event => change('budget_kzt', event.target.value)} />{fieldError('budget_kzt')}</div></div>
              <p className="field-hint">Бюджет на одного подрядчика за мероприятие.</p>
              {activePreferences.length > 0 && <p className="field-hint">Пожелания для AI-сравнения: {activePreferences.join('; ')}.</p>}
              <div className="optional-heading">Дополнительные условия <span>необязательно</span></div>
              <div className="form-row"><div><label htmlFor="language">Язык</label><select {...attributes('language')} value={values.language} onChange={event => change('language', event.target.value)}><option value="">Любой</option>{options?.languages.map(value => <option key={value}>{value}</option>)}</select>{fieldError('language')}</div><div><label htmlFor="hours">Длительность, ч</label><input {...attributes('hours')} type="number" min="0.1" step="any" inputMode="decimal" placeholder="Не задана" value={values.hours} onChange={event => change('hours', event.target.value)} />{fieldError('hours')}</div></div>
              <button type="submit" className="primary" disabled={loading || !options}>{loading ? 'Подбираем…' : 'Подобрать подрядчиков'}<span aria-hidden="true">↗</span></button>
              {options && <p className="calendar-hint">Календарь: {dateLabel(options.date_min)} — {dateLabel(options.date_max)}.</p>}
            </fieldset>
          </form>
        </aside>
        <div className="output-panel" aria-busy={loading}>
          <section className="demo-section" aria-labelledby="demo-title"><div className="demo-heading"><h2 id="demo-title">Попробуйте на примере</h2><span>Запросы к текущему каталогу</span></div><div className="demo-grid">
            {DEMOS.map(demo => <button key={demo.id} type="button" disabled={!options} aria-pressed={activeDemo === demo.id} className={`demo-button ${activeDemo === demo.id ? 'selected' : ''}`} onClick={() => { const form = fromQuery(demo.query); setAssistantRevision(revision => revision + 1); setValues(form); setActiveDemo(demo.id); setActivePreferences([]); void run(form); }}><span className="demo-id">{demo.id}</span><span><strong>{demo.label}</strong><small>{demo.description}</small></span></button>)}
          </div></section>
          {error && <div className="error-box" role="alert"><strong>Подбор не выполнен</strong><p>{error}</p></div>}
          {loading ? <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" /><h2>Проверяем условия и готовим объяснения</h2><p>Учитываем дату, бюджет и особенности мероприятия.</p></div> : result ? <Results result={result} comparison={comparison} comparisonLoading={comparisonLoading} comparisonError={comparisonError} retryComparison={() => { if (comparisonRequest) void runComparison(comparisonRequest.query, comparisonRequest.preferences, comparisonRequest.cards); }} applyAlternative={query => { const form = fromQuery(query); setAssistantRevision(revision => revision + 1); setValues(form); setActiveDemo(null); void run(form, activePreferences); }} /> : !error && <section className="welcome-state"><span className="welcome-symbol" aria-hidden="true">✳</span><h2>Здесь появится ваша подборка</h2><p>Начните с AI-помощника выше или задайте условия в форме. Покажем кандидатов, основания выбора и вопросы для обсуждения.</p><div className="welcome-points"><span>Учитываем занятость</span><span>Объясняем различия</span><span>Показываем ограничения</span></div></section>}
        </div>
      </div>
      <footer className="site-footer"><span>Firebird · прототип команды VibeOps</span><span>Анонимизированный каталог. Только рекомендации.</span></footer>
    </main>
  </>;
}
