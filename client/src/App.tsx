import { useEffect, useState } from 'react';

export function App() {
  const [status, setStatus] = useState('Подключаем каталог…');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(data => setStatus(`Каталог подключён: ${data.dataset_count} профилей`))
      .catch(() => { if (!controller.signal.aborted) setStatus('Не удалось подключить каталог.'); });
    return () => controller.abort();
  }, []);
  return <main><p className="eyebrow">VIBEOPS · FIREBIRD</p><h1>Умный подбор подрядчиков</h1>
    <p role="status">{status}</p><p>Подбор ещё в разработке. Форма и рекомендации появятся после подключения основных модулей.</p>
  </main>;
}
