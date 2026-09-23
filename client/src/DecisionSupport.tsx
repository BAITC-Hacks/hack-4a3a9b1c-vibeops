import type { Card, Query } from '../../shared/contracts';
import type { DecisionSupport as Support } from '../../shared/decision-support';

export default function DecisionSupport({ support, cards, onApply }: {
  support: Support | undefined; cards: Card[]; onApply: (query: Query) => void;
}) {
  if (!support) return null;
  return <>
    {support.comparison.length > 0 && <section className="decision-comparison" aria-labelledby="decision-comparison-title">
      <h3 id="decision-comparison-title">Чем отличаются кандидаты</h3>
      <p className="muted">Короткие основания из тех же профилей. Сведения нужно подтвердить у подрядчиков.</p>
      <ul>{support.comparison.map(item => <li key={item.vendor_id}>
        <strong>{cards.find(card => card.id === item.vendor_id)?.name}</strong><p>{item.feature}</p>
      </li>)}</ul>
    </section>}
    {support.status === 'available' && <section className="decision-alternatives" aria-labelledby="decision-alternatives-title">
      <h3 id="decision-alternatives-title">Как расширить подбор</h3>
      <p className="muted">Каждый вариант меняет только дату или бюджет. Применим его только по вашему выбору.</p>
      <div className="alternative-grid">{support.alternatives.map(alternative => <div className="alternative-card" key={alternative.kind}>
        <h4>{alternative.title}</h4><p>{alternative.explanation}</p>
        <button type="button" className="secondary" onClick={() => onApply(alternative.query)}>{alternative.kind === 'date' ? 'Применить дату' : 'Применить бюджет'}</button>
      </div>)}</div>
      {support.message && <p className="muted">{support.message}</p>}
    </section>}
    {support.status === 'no_single_change' && <p className="notice">{support.message || 'Смена только даты в пределах недели или увеличение бюджета не расширяет подбор. Проверьте остальные условия в форме.'}</p>}
  </>;
}
