# Промпт агенту Никиты

Ты реализуешь backend новой функции Firebird в командном репозитории BAITC-Hacks/hack-4a3a9b1c-vibeops.

Сначала прочитай AGENTS.md, docs/decision-support/SPEC.md, shared/contracts.ts, shared/decision-support.ts, server/matching.ts и server/explanations/decision-support.ts. Проверь git status и текущий main. Сохрани чужие изменения; не force-push и не reset. Создай свою ветку от актуального main либо аккуратно объедини его с рабочей веткой.

Реализуй server/alternatives.ts с buildDecisionSupport(catalog, original, cards) по точному алгоритму SPEC. Подключи результат как decision_support в server/recommend.ts после получения текущих cards. Исходные Query/cards/outcome/summary и stable ranking не меняй. Используй готовые describeAlternative/buildComparison; альтернативы вычисляй selectVendors без новых LLM-вызовов. Поле всегда присутствует в новом backend, хотя тип временно optional для совместимости.

Напиши содержательные тесты дат ±7, границ календаря, минимального бюджета, неизменности остальных условий, статусов и повторного применения предложений через HTTP. Не считать сравнение только top-3 проверкой всех eligible. Не добавлять новые API endpoints, зависимости или изменения shared-контракта без необходимости и согласования.

В app.ts есть console.error(err), который печатает целиком ошибки и body некорректного JSON; убери сырой вывод либо замени кратким безопасным кодом без body/ключей/stack внешнего сервиса. Для ожидаемых 4xx полный stack не нужен.

Проверь npm test, npm run test:ui, npm run build и настоящий D1–D6. Подготовь реальные примеры: исходный запрос, предложение даты/бюджета, повторный запрос с подтверждённым приростом. Не публикуй секреты. Обнови README реализованным поведением и ограничением ±7/одного изменения.

Сделай небольшой commit/push/PR в main. В отчёте укажи SHA, тесты, примеры и ограничения. Не менять client/**, tests/ui/** или нашу server/explanations/**. Проверка с live AI отдельно от fallback, доступ экспертов пока отдельный незакрытый пункт.
