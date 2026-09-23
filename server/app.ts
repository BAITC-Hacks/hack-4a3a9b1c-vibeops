/*
import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { catalogOptions, type Catalog } from './catalog.js';
import type { ApiError } from '../shared/contracts.js';
import { recommend } from './recommend.js';

export function createApp(catalog: Catalog | null) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  const error = (code: string, message: string): ApiError => ({ error: { code, message, fields: {} } });
  app.get('/api/health', (_req, res) => {
    if (!catalog) { res.status(503).json(error('DATASET_UNAVAILABLE', 'Каталог недоступен.')); return; }
    res.json({ status: 'ok', dataset_count: catalog.vendors.length, ai_configured: Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.OPENAI_MODEL?.trim()) });
  });
  app.get('/api/options', (_req, res) => {
    if (!catalog) { res.status(503).json(error('DATASET_UNAVAILABLE', 'Каталог недоступен.')); return; }
    res.json(catalogOptions(catalog));
  });
  // Nikita replaces this explicit scaffold state with validation -> matching -> explanations.
 curl -X POST http://localhost:3000/api/recommend \
  -H 'Content-Type: application/json' \
  -d '{
    "city": "Астана",
    "date": "2026-11-14",
    "event_format": "свадьба",
    "category": "Фотограф",
    "budget_kzt": 300000
  }' app.post('/api/recommend', (req, res) => {
    if (!catalog) {
      res.status(503).json(
        error('DATASET_UNAVAILABLE', 'Каталог недоступен.')
      );
      return;
    }

    const result = recommend(catalog, req.body);

    res.json(result);
  });

  app.use('/api', (_req, res) => { res.status(404).json(error('NOT_FOUND', 'API-маршрут не найден.')); });
  const clientRoot = resolve('dist/client');
  if (existsSync(resolve(clientRoot, 'index.html'))) {
    app.use(express.static(clientRoot));
    app.get('/', (_req, res) => { res.sendFile(resolve(clientRoot, 'index.html')); });
  }
  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') { res.status(400).json(error('MALFORMED_JSON', 'Некорректный JSON.')); return; }
    if (err?.type === 'entity.too.large') { res.status(413).json(error('PAYLOAD_TOO_LARGE', 'Запрос слишком большой.')); return; }
    res.status(500).json(error('INTERNAL_ERROR', 'Внутренняя ошибка сервера.'));
  };
  app.use(handleError);
  return app;
}*/

import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { catalogOptions, type Catalog } from './catalog.js';
import type { ApiError } from '../shared/contracts.js';
import { recommend } from './recommend.js';

export function createApp(catalog: Catalog | null) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  const error = (code: string, message: string): ApiError => ({
    error: {
      code,
      message,
      fields: {},
    },
  });

  app.get('/api/health', (_req, res) => {
    if (!catalog) {
      res.status(503).json(
        error('DATASET_UNAVAILABLE', 'Каталог недоступен.')
      );
      return;
    }

    res.json({
      status: 'ok',
      dataset_count: catalog.vendors.length,
      ai_configured: Boolean(
        process.env.OPENAI_API_KEY?.trim() &&
        process.env.OPENAI_MODEL?.trim()
      ),
    });
  });

  app.get('/api/options', (_req, res) => {
    if (!catalog) {
      res.status(503).json(
        error('DATASET_UNAVAILABLE', 'Каталог недоступен.')
      );
      return;
    }

    res.json(catalogOptions(catalog));
  });

  app.post('/api/recommend', (req, res) => {
    if (!catalog) {
      res.status(503).json(
        error('DATASET_UNAVAILABLE', 'Каталог недоступен.')
      );
      return;
    }

    const result = recommend(catalog, req.body);

    res.json(result);
  });

  app.use('/api', (_req, res) => {
    res.status(404).json(
      error('NOT_FOUND', 'API-маршрут не найден.')
    );
  });

  const clientRoot = resolve('dist/client');

  if (existsSync(resolve(clientRoot, 'index.html'))) {
    app.use(express.static(clientRoot));

    app.get('/', (_req, res) => {
      res.sendFile(resolve(clientRoot, 'index.html'));
    });
  }

  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json(
        error('MALFORMED_JSON', 'Некорректный JSON.')
      );
      return;
    }

    if (err?.type === 'entity.too.large') {
      res.status(413).json(
        error('PAYLOAD_TOO_LARGE', 'Запрос слишком большой.')
      );
      return;
    }

    res.status(500).json(
      error('INTERNAL_ERROR', 'Внутренняя ошибка сервера.')
    );
  };

  app.use(handleError);

  return app;
}
