"use strict";

// Grundeinstellungen und Bezeichnungen für beide Ansichten.
const el = id => document.getElementById(id);
const legacyStorageKey = 'munster-concept-demo-unused-legacy-storage';
const mapCenter = [52.986, 10.09];
const townZoom = 14;
const districts = new Map([
  ['munster', 'Munster (Kernstadt)'],
  ['alvern', 'Alvern'],
  ['breloh', 'Breloh'],
  ['ilster', 'Ilster'],
  ['lopau', 'Lopau'],
  ['oerrel', 'Oerrel'],
  ['toepingen', 'Töpingen'],
  ['trauen', 'Trauen'],
]);
const fallbackCategory = 'Sonstiges';
const removedCategory = /^straßen? und wege$/i;
const defaultCategories = ['Grünpflege', 'Reinigung', 'Instandhaltung', fallbackCategory];
const noDistrict = 'Ohne Ortszuordnung';

// Datumswerte im Arbeitsplan sind Kalendertage ohne Uhrzeit.
const dayLength = 86400000;
const deadlineLabels = {
  ok: 'Im Intervall',
  halfway: 'Halbzeit erreicht',
  soon: 'Bald fällig',
  today: 'Heute fällig',
  overdue: 'Überfällig',
};
const deadlineFormat = new Intl.DateTimeFormat('de-DE', {dateStyle:'medium', timeZone:'UTC'});
const berlinCalendar = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Berlin'});

function today() {
  // Erst den Berliner Kalendertag bestimmen, dann als Tageszahl darstellen.
  return dateTimestamp(berlinCalendar.format(new Date())) / dayLength;
}

function dateAfter(day, intervalDays) {
  return new Date((day + intervalDays) * dayLength).toISOString().split('T')[0].replace(/^\+0*/, '');
}

function dateTimestamp(value) {
  // UTC verhindert, dass ein Wechsel der Sommerzeit einen Kalendertag verkürzt oder verlängert.
  const [year, month, day] = value.split('-').map(Number);
  return new Date(0).setUTCFullYear(year, month - 1, day);
}

function intervalProgress(task, day) {
  // Einmalige Aufgaben haben keinen Intervallfortschritt.
  if (!task.intervalDays) return null;
  const dueDay = dateTimestamp(task.due) / dayLength;
  if (!Number.isFinite(dueDay)) return null;

  // Aus Fälligkeit und Intervalllänge ergibt sich der Beginn des aktuellen Intervalls.
  const startDay = dueDay - task.intervalDays;
  const elapsedDays = day - startDay;
  const percent = Math.max(0, Math.min(100, Math.floor(elapsedDays * 100 / task.intervalDays)));
  return {remaining: dueDay - day, percent};
}

function deadlineState(progress) {
  if (!progress) return null;
  // Den Fälligkeitstag und überfällige Aufgaben separat beschriften.
  if (progress.remaining < 0) return 'overdue';
  if (progress.remaining === 0) return 'today';
  if (progress.percent >= 90) return 'soon';
  if (progress.percent >= 50) return 'halfway';
  return 'ok';
}

function zoneDeadline(zone, day) {
  const states = zone.tasks.map(task => deadlineState(intervalProgress(task, day)));
  // Die dringendste Aufgabe bestimmt die Farbe der gesamten Fläche.
  return ['overdue', 'today', 'soon', 'halfway', 'ok'].find(state => states.includes(state));
}

function deadlineColor(state, zoneColor) {
  if (state === 'ok') return '#187b47';
  if (state === 'halfway') return '#d4aa00';
  // Bei einem Abschnitt ohne Intervall bleibt die gewählte Kartenfarbe sichtbar.
  return state ? '#bb2c36' : zoneColor;
}

// API-Zugriff und kleine Hilfen für die HTML-Elemente.
function say(message) {
  const notice = el('notice');
  notice.textContent = message;
  notice.hidden = !message;
}

const planRequest = demoPlanRequest;

function button(label, action) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.onclick = action;
  return node;
}

function option(value, label = value) {
  return new Option(label, value);
}

function districtOptions() {
  return Array.from(districts, ([value, label]) => option(value, label));
}

function taskDescription(task, day) {
  // Gespeicherte Zuständigkeiten aus älteren Daten werden weiterhin angezeigt.
  const timestamp = dateTimestamp(task.due);
  const date = Number.isFinite(timestamp) ? deadlineFormat.format(timestamp) : task.due;
  const interval = task.intervalDays === 1 ? 'Täglich' : 'Alle ' + task.intervalDays + ' Tage';
  const progress = intervalProgress(task, day);
  return [
    task.owner,
    task.intervalDays && interval,
    date && (task.intervalDays ? 'Nächster Termin ' : 'Fällig am ') + date,
    progress && progress.percent + ' % verstrichen',
    deadlineLabels[deadlineState(progress)],
    task.status === 'Erledigt' && 'Erledigt',
  ].filter(Boolean).join(' · ');
}

function showPlan({role, version, zones}, canManage) {
  if (!window.L) {
    say('Die Kartenbibliothek konnte nicht geladen werden. Prüfe die Internetverbindung und lade die Seite neu.');
    return;
  }
  // Beide Rollen teilen die Karte. Bearbeitungswerkzeuge werden nur für die Manageransicht aktiviert.
  const view = el('planView');
  const managerTools = el('managerTools');
  view.hidden = false;
  managerTools.hidden = !canManage;
  el('backToManager').hidden = canManage || role !== 'manager';
  el('zoneActions').hidden = !canManage;
  el('taskForm').hidden = !canManage;
  const refreshOrders = el('refreshOrders');
  refreshOrders.hidden = canManage;
  refreshOrders.onclick = () => refreshOrdersView();
  const importLocal = el('importLocal');
  let localZones = [];
  if (canManage) {
    try {
      // Frühere rein lokale Versionen haben Abschnitte im Browser abgelegt.
      const stored = JSON.parse(localStorage.getItem(legacyStorageKey) || '[]');
      for (const zone of stored) {
        if (removedCategory.test(zone.category.trim())) zone.category = fallbackCategory;
      }
      localZones = stored;
    } catch { say('Die früher im Browser gespeicherten Abschnitte konnten nicht gelesen werden.'); }
  }
  const importedIds = new Set();
  // Eine Kopie des letzten bestätigten Plans erlaubt die Rückkehr bei Schreibfehlern.
  let savedZones = canManage ? structuredClone(zones) : null;

  async function refreshOrdersView(completion) {
    // Die Anwenderansicht lädt nach dem Abhaken den Stand vom Server, auch bei einem Versionskonflikt.
    view.inert = true;
    let message = '';
    try {
      if (completion) await planRequest('complete', 'POST', {...completion, version});
    } catch (error) { message = error.message; }
    try {
      ({version, zones} = await planRequest('plan'));
      render();
    } catch (error) { message ||= error.message; }
    view.inert = false;
    say(message);
  }

  async function save() {
    // Während eines Schreibvorgangs keine weiteren Änderungen in derselben Ansicht zulassen.
    view.inert = true;
    managerTools.inert = true;
    try {
      const result = await planRequest('plan', 'PUT', {version, zones});
      version = result.version;
      savedZones = structuredClone(zones);
      say('');
      return true;
    } catch (error) {
      zones = structuredClone(savedZones);
      if (error.status === 409) {
        try {
          ({version, zones} = await planRequest('plan'));
          savedZones = structuredClone(zones);
        } catch {
          // Falls auch das Nachladen scheitert, bleibt die letzte bestätigte Kopie erhalten.
        }
      }
      say(error.message + ' Deine Änderung wurde nicht gespeichert.');
      resetTask();
      render();
      return false;
    } finally {
      view.inert = false;
      managerTools.inert = false;
    }
  }

  function saveAndRender() {
    // Die Änderung sofort zeigen. save() korrigiert die Anzeige bei einem Fehler.
    void save();
    render();
  }

  function localSectionsToImport() {
    // Ein im gemeinsamen Plan vorhandener Abschnitt darf durch den Import nicht überschrieben werden.
    const knownIds = new Set([...importedIds, ...zones.map(zone => zone.id)]);
    return localZones.filter(zone => !knownIds.has(zone.id));
  }
  if (canManage) {
    importLocal.onclick = async () => {
      const pending = localSectionsToImport();
      zones.push(...pending);
      if (await save()) {
        for (const zone of pending) importedIds.add(zone.id);
      }
      render();
    };
  }

  // Gespeicherte Flächen und der aktuelle Entwurf liegen auf getrennten Kartenebenen.
  const map = L.map('map').setView(mapCenter, townZoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  const layers = L.layerGroup().addTo(map);
  const draft = L.layerGroup().addTo(map);
  const filter = el('filter');
  const districtFilter = el('districtFilter');
  const districtPicker = el('districtPicker');
  const districtForm = el('districtForm');
  const drawDistrict = el('drawDistrict');
  const editor = el('editor');
  const zoneForm = el('zoneForm');
  const zoneDistrict = el('zoneDistrict');
  const zoneCategory = zoneForm.elements.category;
  const taskForm = el('taskForm');
  districtFilter.replaceChildren(option('', 'Alle Orte'), ...districtOptions(), option('unassigned', noDistrict));
  drawDistrict.replaceChildren(option('', 'Bitte auswählen'), ...districtOptions());
  zoneDistrict.replaceChildren(option('', noDistrict), ...districtOptions());
  let selected;
  // Eine leere Punktliste steht für einen aktiven Entwurf. null bedeutet, dass gerade niemand zeichnet.
  let points = null;
  let draftDistrict = '';
  let editingZone = false;
  let editingTask;
  let renderedDay;

  function resetTask() {
    editingTask = undefined;
    taskForm.reset();
    el('saveTask').textContent = 'Aufgabe hinzufügen';
    el('cancelTask').hidden = true;
  }

  function choose(zone, zoom) {
    if (points) return;
    selected = zone.id;
    resetTask();
    render();
    // Ein Klick in der Liste zoomt zur Fläche. Ein Klick auf der Karte behält den Ausschnitt bei.
    if (zoom) map.fitBounds(zone.points, {padding: [45, 70], maxZoom: 17});
  }

  function render() {
    // Aus einem Planstand werden die Filter, die Karte und die ausgewählten Aufträge gemeinsam aufgebaut.
    renderedDay = today();
    importLocal.hidden = !canManage || localSectionsToImport().length === 0;
    const category = filter.value;
    const categories = [...new Set([...defaultCategories, ...zones.map(zone => zone.category)])]
      .sort((left, right) => left.localeCompare(right, 'de'));
    filter.replaceChildren(option('', 'Alle Kategorien'), ...categories.map(value => option(value)));
    filter.value = categories.includes(category) ? category : '';
    if (canManage) {
      const currentCategory = zoneCategory.value;
      zoneCategory.replaceChildren(option('', 'Bitte auswählen'), ...categories.map(value => option(value)));
      zoneCategory.value = categories.includes(currentCategory) ? currentCategory : '';
    }
    // Beide Filter wirken gleichzeitig auf die Kartenflächen und die Liste.
    const visible = zones.filter(zone =>
      (!filter.value || zone.category === filter.value) &&
      (!districtFilter.value || (zone.district || 'unassigned') === districtFilter.value)
    );
    let current = visible.find(zone => zone.id === selected);
    if (!current && !canManage) {
      current = visible.find(zone => zone.tasks.length) || visible[0];
      selected = current?.id;
    }
    layers.clearLayers();
    el('list').replaceChildren();
    const open = visible.flatMap(zone => zone.tasks).filter(task => task.status !== 'Erledigt').length;
    el('summary').textContent = visible.length + ' Abschnitte · ' + open + ' unerledigte Aufgaben';
    if (!visible.length) {
      el('list').textContent = filter.value || districtFilter.value
        ? 'Keine Abschnitte für diese Filter.'
        : (canManage ? 'Zeichne deinen ersten Abschnitt auf der Karte.' : 'Es sind noch keine Abschnitte vorhanden.');
    }
    for (const zone of visible) renderZone(zone, current);

    el('detail').hidden = !current;
    if (!current) return;
    el('zoneName').textContent = current.title;
    el('zoneCategory').textContent = [districts.get(current.district) || noDistrict, current.category].join(' · ');
    el('tasks').replaceChildren();
    if (!current.tasks.length) el('tasks').textContent = 'Noch keine Aufgaben.';
    for (const task of current.tasks) renderTask(current, task);
  }

  function renderZone(zone, current) {
    // Die Fläche, der Tooltip und der Listeneintrag zeigen denselben Intervallstatus.
    const state = zoneDeadline(zone, renderedDay);
    const color = deadlineColor(state, zone.color);
    const shape = L.polygon(zone.points, {
      color,
      weight: zone === current ? 4 : 2,
      fillOpacity: state ? 0.32 : 0.24,
    }).addTo(layers);
    const name = document.createElement('span');
    const district = districts.get(zone.district);
    // Mit textContent bleiben eingegebene Abschnittsnamen reiner Text im Tooltip.
    name.textContent = [zone.title, district, deadlineLabels[state]].filter(Boolean).join(' · ');
    shape.bindTooltip(name);
    shape.on('click', () => choose(zone, false));
    const item = button(
      [zone.title, district || noDistrict, zone.category].join(' · '),
      () => choose(zone, true)
    );
    item.style.setProperty('--zone', color);
    item.setAttribute('aria-pressed', String(zone === current));
    if (state) {
      const label = document.createElement('span');
      label.className = 'deadline';
      label.style.color = state === 'halfway' ? '#755900' : color;
      label.textContent = deadlineLabels[state];
      item.append(label);
    }
    el('list').append(item);
  }

  function renderTask(current, task) {
    const recurring = Boolean(task.intervalDays);
    const completed = !recurring && task.status === 'Erledigt';
    const row = document.createElement('div');
    row.className = 'task';
    const title = document.createElement('strong');
    title.textContent = task.title;
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = taskDescription(task, renderedDay);
    meta.hidden = !meta.textContent;
    row.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'row';
    if (canManage) {
      const complete = button(completed ? 'Wieder öffnen' : 'Als erledigt markieren', () => {
        if (recurring) {
          const previousDue = task.due;
          task.due = dateAfter(today(), task.intervalDays);
          // Ein bereits geöffnetes Formular übernimmt den neuen Termin, solange er dort nicht bearbeitet wurde.
          if (editingTask === task.id && taskForm.elements.due.value === previousDue) {
            taskForm.elements.due.value = task.due;
          }
        }
        task.status = recurring || completed ? 'Offen' : 'Erledigt';
        saveAndRender();
      });
      const edit = button('Bearbeiten', () => {
        // Das vorhandene Aufgabenformular wird beim Bearbeiten mit den gespeicherten Werten gefüllt.
        editingTask = task.id;
        for (const key of ['title', 'due']) taskForm.elements[key].value = task[key];
        taskForm.elements.intervalDays.value = task.intervalDays || '';
        el('saveTask').textContent = 'Änderungen speichern';
        el('cancelTask').hidden = false;
        taskForm.elements.title.focus();
      });
      const remove = button('Löschen', () => {
        if (!confirm('Aufgabe „' + task.title + '“ löschen?')) return;
        current.tasks = current.tasks.filter(item => item !== task);
        if (editingTask === task.id) resetTask();
        saveAndRender();
      });
      actions.append(complete, edit, remove);
    } else if (!completed) {
      // Die Anwenderansicht meldet nur die Erledigung. Der Server berechnet den nächsten Termin.
      actions.append(button('Als erledigt markieren', () =>
        refreshOrdersView({zoneId: current.id, taskId: task.id})
      ));
    }
    if (actions.childElementCount) row.append(actions);
    el('tasks').append(row);
  }

  function paintDraft() {
    draft.clearLayers();
    const drawing = points !== null;
    for (const id of ['hint', 'undo', 'finish', 'cancel']) el(id).hidden = !drawing;
    el('new').disabled = drawing;
    map.getContainer().style.cursor = drawing ? 'crosshair' : '';
    if (!drawing) return;
    el('hint').textContent = districts.get(draftDistrict) + ' · Eckpunkte anklicken · ' + points.length + ' gesetzt';
    el('undo').disabled = points.length === 0;
    el('finish').disabled = points.length < 3;
    // Aus zwei Punkten wird zunächst eine Linie, ab drei Punkten eine geschlossene Vorschau.
    if (points.length > 2) L.polygon(points, {interactive:false, dashArray:'6 5'}).addTo(draft);
    else if (points.length > 1) L.polyline(points, {interactive:false}).addTo(draft);
    for (const point of points) L.circleMarker(point, {radius:5, interactive:false, fillOpacity:1}).addTo(draft);
  }
  // Navigation und Filter stehen in beiden Ansichten zur Verfügung.
  el('home').onclick = () => map.setView(mapCenter, townZoom);
  filter.onchange = districtFilter.onchange = () => {
    resetTask();
    render();
  };
  // Nur in der Manageransicht auf Zeichen- und Formularaktionen reagieren.
  if (canManage) {
    map.on('click', event => {
      if (!points) return;
      const point = [event.latlng.lat, event.latlng.lng];
      // Doppelklicks und fast identische Punkte erzeugen keinen weiteren Eckpunkt.
      if (points.some(other => L.latLng(other).distanceTo(point) < 1)) return;
      points.push(point);
      paintDraft();
    });
    el('new').onclick = () => {
      drawDistrict.value = districts.has(districtFilter.value) ? districtFilter.value : '';
      districtPicker.showModal();
    };
    el('closeDistrictPicker').onclick = () => districtPicker.close();
    districtForm.onsubmit = event => {
      event.preventDefault();
      if (!districts.has(drawDistrict.value)) return;
      draftDistrict = drawDistrict.value;
      points = [];
      districtPicker.close();
      paintDraft();
    };
    el('undo').onclick = () => {
      points.pop();
      paintDraft();
    };
    el('cancel').onclick = () => {
      points = null;
      paintDraft();
    };
    el('finish').onclick = () => {
      editingZone = false;
      zoneForm.reset();
      zoneDistrict.required = true;
      zoneDistrict.value = draftDistrict;
      el('editorTitle').textContent = 'Abschnitt benennen';
      editor.showModal();
    };
    el('edit').onclick = () => {
      if (points) return;
      const zone = zones.find(item => item.id === selected);
      editingZone = true;
      zoneDistrict.required = false;
      zoneDistrict.value = zone.district || '';
      for (const key of ['title', 'category', 'color']) zoneForm.elements[key].value = zone[key];
      el('editorTitle').textContent = 'Abschnitt bearbeiten';
      editor.showModal();
    };
    el('closeEditor').onclick = () => editor.close();
    zoneForm.onsubmit = event => {
      event.preventDefault();
      const fields = zoneForm.elements;
      const title = fields.title.value.trim();
      const category = zoneCategory.value;
      if (!title || !category) {
        fields[title ? 'category' : 'title'].focus();
        return;
      }
      const district = zoneDistrict.value;
      if ((!editingZone || district) && !districts.has(district)) {
        zoneDistrict.focus();
        return;
      }
      const data = {title, category, color: fields.color.value, district};
      if (editingZone) {
        // Beim Bearbeiten bleiben die Eckpunkte und Aufgaben des Abschnitts erhalten.
        Object.assign(zones.find(zone => zone.id === selected), data);
      } else {
        selected = String(Date.now()) + Math.random();
        zones.push({...data, id: selected, points, tasks: []});
        points = null;
        resetTask();
        paintDraft();
      }
      // Den gespeicherten Abschnitt auch nach einer Änderung seiner Zuordnung sichtbar lassen.
      filter.value = '';
      if (districtFilter.value !== (district || 'unassigned')) districtFilter.value = '';
      editor.close();
      saveAndRender();
    };
    el('remove').onclick = () => {
      if (points) return;
      const zone = zones.find(item => item.id === selected);
      if (!confirm('Abschnitt „' + zone.title + '“ samt Aufgaben löschen?')) return;
      zones = zones.filter(item => item !== zone);
      selected = undefined;
      resetTask();
      saveAndRender();
    };
    el('cancelTask').onclick = resetTask;
    taskForm.onsubmit = event => {
      event.preventDefault();
      const fields = taskForm.elements;
      const title = fields.title.value.trim();
      if (!title) {
        fields.title.focus();
        return;
      }
      const zone = zones.find(item => item.id === selected);
      const intervalDays = fields.intervalDays.valueAsNumber || 0;
      // Bei einem leeren Datum beginnt eine Wiederholung heute. Einmalige Aufgaben dürfen undatiert bleiben.
      const due = fields.due.value || (intervalDays ? dateAfter(today(), intervalDays) : '');
      const data = {title, due, intervalDays};
      if (editingTask) {
        const task = zone.tasks.find(task => task.id === editingTask);
        Object.assign(task, data);
        if (intervalDays && task.status === 'Erledigt') task.status = 'Offen';
      } else {
        zone.tasks.push({...data, id: String(Date.now()) + Math.random(), status: 'Offen'});
      }
      resetTask();
      saveAndRender();
    };
  }
  render();

  // Farben und Prozentwerte aktualisieren sich auch dann, wenn die Seite über Mitternacht geöffnet bleibt.
  function refreshDeadlines() {
    if (today() !== renderedDay) render();
  }
  document.addEventListener('visibilitychange', refreshDeadlines);
  setInterval(refreshDeadlines, 30000);
}

// Der Server bestimmt die Rolle. Ein Manager kann zusätzlich die Anwenderansicht als Vorschau öffnen.
planRequest('plan').then(state => {
  const canManage = state.role === 'manager' && new URLSearchParams(location.search).get('ansicht') !== 'anwender';
  showPlan(state, canManage);
}).catch(error => say(error.message || 'Der Arbeitsplan konnte nicht geladen werden.'));
