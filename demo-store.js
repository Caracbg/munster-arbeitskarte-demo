'use strict';

// GitHub Pages liefert nur Dateien aus. Dieses Skript speichert ausschließlich Demo-Daten im Browser.
const demoStorageKey = 'munster-arbeitskarte-concept-demo-v1';

function demoSeed() {
  const day = today();
  const examples = [
    ['stadtpark', 'Beispielfläche Stadtpark', 'munster', 'Grünpflege', 52.9827, 10.0868, 'Rasen mähen', 20],
    ['breloh', 'Beispielfläche Breloh', 'breloh', 'Reinigung', 53.0120, 10.0914, 'Mülleimer leeren', 8],
    ['ortszentrum', 'Beispielfläche Ortszentrum', 'munster', 'Instandhaltung', 52.9880, 10.0890, 'Sitzbank kontrollieren', 1],
  ];
  return {
    version: 1,
    zones: examples.map(([id, title, district, category, lat, lng, task, remainingDays]) => ({
      id, title, district, category,
      color: '#287b64',
      points: [[lat, lng], [lat, lng + .0015], [lat + .0008, lng + .0015], [lat + .0008, lng]],
      tasks: [{id: id + '-1', title: task, status: 'Offen', intervalDays: 20, due: dateAfter(day, remainingDays)}],
    })),
  };
}

function saveDemo(state) {
  localStorage.setItem(demoStorageKey, JSON.stringify(state));
}

// Dieselben Aktionen wie beim Server, damit sich Zeichnen, Bearbeiten und Abhaken ausprobieren lassen.
async function demoPlanRequest(path, method = 'GET', body) {
  let state = JSON.parse(localStorage.getItem(demoStorageKey) || 'null');
  if (!state) {
    state = demoSeed();
    saveDemo(state);
  }
  if (path === 'plan' && method === 'GET') return {...state, role: 'manager'};
  if (body?.version !== state.version) {
    throw Object.assign(new Error('Die Demo wurde inzwischen in einem anderen Tab geändert.'), {status: 409});
  }
  if (path === 'plan' && method === 'PUT') {
    state.zones = body.zones;
  } else if (path === 'complete' && method === 'POST') {
    const task = state.zones.find(zone => zone.id === body.zoneId)?.tasks.find(item => item.id === body.taskId);
    if (!task) throw new Error('Der Demo-Auftrag wurde nicht gefunden.');
    if (task.intervalDays) {
      task.due = dateAfter(today(), task.intervalDays);
      task.status = 'Offen';
    } else {
      task.status = 'Erledigt';
    }
  } else {
    throw new Error('Diese Demo-Aktion ist nicht verfügbar.');
  }
  state.version += 1;
  saveDemo(state);
  return {version: state.version};
}

document.getElementById('resetDemo').onclick = () => {
  if (!confirm('Demo auf die Beispieldaten zurücksetzen?')) return;
  localStorage.removeItem(demoStorageKey);
  location.reload();
};
