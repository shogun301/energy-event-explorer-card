import { evaluateEnergyEvents, integratePower, localDayRange, shiftRangeByCalendarDays, validRange } from "./engine.js";

const RANGE_STORE = window.__energyEventExplorerRanges || (window.__energyEventExplorerRanges = new Map());
const RANGE_EVENT = "energy-event-explorer-range-changed";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function sharedRange(key) {
  const stored = RANGE_STORE.get(key);
  if (!stored) return null;
  const start = new Date(stored.start), end = new Date(stored.end);
  return validRange(start, end) ? { start, end } : null;
}

function setSharedRange(key, start, end) {
  if (!key || !validRange(start, end)) return;
  RANGE_STORE.set(key, { start: start.toISOString(), end: end.toISOString() });
  window.dispatchEvent(new CustomEvent(RANGE_EVENT, { detail: { key, start: start.toISOString(), end: end.toISOString() } }));
}

function descriptor(value) {
  return typeof value === "string" ? { entity: value, source: "statistics" } : { source: "statistics", ...value };
}

function metricDescriptors(entities) {
  return Object.fromEntries(Object.entries(entities || {}).map(([alias, value]) => [alias, descriptor(value)]));
}

function historyRows(response, entityId) {
  if (Array.isArray(response)) {
    const list = response.find((entry) => Array.isArray(entry) && entry.some((row) => row?.entity_id === entityId)) || [];
    return list;
  }
  return response?.[entityId] || [];
}

async function loadSeries(hass, entities, start, queryEnd, bucketMinutes) {
  const descriptors = metricDescriptors(entities);
  const statistics = Object.entries(descriptors).filter(([, item]) => item.source !== "history");
  const histories = Object.entries(descriptors).filter(([, item]) => item.source === "history");
  const output = {};
  if (statistics.length) {
    const ids = [...new Set(statistics.map(([, item]) => item.entity))];
    const response = await hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(), end_time: queryEnd.toISOString(),
      statistic_ids: ids, period: bucketMinutes === 5 ? "5minute" : "hour",
      units: { power: "kW" }, types: ["mean"],
    });
    for (const [alias, item] of statistics) {
      output[alias] = (response?.[item.entity] || []).map((row) => ({ t: new Date(row.start).getTime(), v: Number(row.mean) }))
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v));
    }
  }
  if (histories.length) {
    const ids = [...new Set(histories.map(([, item]) => item.entity))];
    const response = await hass.callWS({
      type: "history/history_during_period", start_time: start.toISOString(), end_time: queryEnd.toISOString(),
      entity_ids: ids, minimal_response: false, no_attributes: false, significant_changes_only: false,
    });
    for (const [alias, item] of histories) {
      const changes = historyRows(response, item.entity).map((row) => {
        const raw = item.attribute ? row.attributes?.[item.attribute] : (row.state ?? row.s);
        const numeric = Number(raw);
        return { t: new Date(row.last_updated || row.last_changed || row.lu).getTime(), v: Number.isFinite(numeric) ? numeric : raw };
      }).filter((point) => Number.isFinite(point.t) && point.v !== undefined && point.v !== null).sort((a, b) => a.t - b.t);
      const held = [];
      let index = 0, current;
      for (let time = start.getTime(); time < queryEnd.getTime(); time += bucketMinutes * 60000) {
        while (index < changes.length && changes[index].t <= time) current = changes[index++].v;
        if (current !== undefined) held.push({ t: time, v: current });
      }
      output[alias] = held;
    }
  }
  return output;
}

class RangeAwareCard extends HTMLElement {
  connectedCallback() {
    this._rangeListener = (event) => {
      if (event.detail?.key === this.config?.range_key) this._load(true);
    };
    window.addEventListener(RANGE_EVENT, this._rangeListener);
    this._resizeObserver = new ResizeObserver(() => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._render(), 60);
    });
    this._resizeObserver.observe(this);
  }
  disconnectedCallback() {
    window.removeEventListener(RANGE_EVENT, this._rangeListener);
    this._resizeObserver?.disconnect();
    clearTimeout(this._resizeTimer);
  }
  set hass(hass) { this._hass = hass; this._load(); }
  _range() { return sharedRange(this.config.range_key) || localDayRange(); }
}

export class EnergyEventRangeSelectorCard extends HTMLElement {
  setConfig(config) {
    this.config = { range_key: "energy-events", ...config };
    if (!this.config.range_key) throw new Error("range_key is required");
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._selected = sharedRange(this.config.range_key) || localDayRange();
    this._render();
  }
  set hass(hass) { this._hass = hass; if (!sharedRange(this.config.range_key)) this._commit(this._selected); }
  getCardSize() { return 2; }
  _format(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  _parse(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || "")) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  _commit(range) {
    if (!validRange(range.start, range.end)) return;
    this._selected = { start: new Date(range.start), end: new Date(range.end) };
    setSharedRange(this.config.range_key, this._selected.start, this._selected.end);
    this._sync();
  }
  _sync() {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelector(".start").value = this._format(this._selected.start);
    this.shadowRoot.querySelector(".end").value = this._format(this._selected.end);
    this.shadowRoot.querySelector(".summary").textContent = new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).formatRange(this._selected.start, this._selected.end);
  }
  _apply() {
    const start = this._parse(this.shadowRoot.querySelector(".start").value);
    const endInput = this.shadowRoot.querySelector(".end"), end = this._parse(endInput.value);
    if (!start || !end) return;
    if (end <= start) { endInput.setCustomValidity("End must be after start"); endInput.reportValidity(); return; }
    endInput.setCustomValidity(""); this._commit({ start, end });
  }
  _render() {
    this.shadowRoot.innerHTML = `<style>
      :host,ha-card{display:block;min-width:0;max-width:100%}.content{display:grid;grid-template-columns:1fr 1fr auto;gap:9px 12px;align-items:end;padding:14px 18px}
      label{display:grid;gap:4px;color:var(--secondary-text-color);font-size:11px}input{width:100%;box-sizing:border-box;min-height:36px;border:1px solid var(--divider-color);border-radius:8px;padding:5px 8px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit;color-scheme:dark}
      .actions{display:flex;gap:5px}.actions button{min-height:36px;border:1px solid var(--divider-color);border-radius:18px;background:transparent;color:var(--primary-text-color);padding:0 13px;cursor:pointer}.today{color:var(--primary-color)!important;border-color:var(--primary-color)!important}.summary{grid-column:1/-1;font-weight:600}
      @media(max-width:620px){.content{grid-template-columns:1fr;padding:12px}.actions{justify-content:space-between}.summary{grid-column:1}}
      </style><ha-card><div class="content"><label>Start<input class="start" type="datetime-local"></label><label>End<input class="end" type="datetime-local"></label><div class="actions"><button class="prev" aria-label="Previous calendar day">‹</button><button class="today">Today</button><button class="next" aria-label="Next calendar day">›</button></div><div class="summary"></div></div></ha-card>`;
    this.shadowRoot.querySelector(".start").addEventListener("change", () => this._apply());
    this.shadowRoot.querySelector(".end").addEventListener("change", () => this._apply());
    this.shadowRoot.querySelector(".prev").addEventListener("click", () => this._commit(shiftRangeByCalendarDays(this._selected.start, this._selected.end, -1)));
    this.shadowRoot.querySelector(".next").addEventListener("click", () => this._commit(shiftRangeByCalendarDays(this._selected.start, this._selected.end, 1)));
    this.shadowRoot.querySelector(".today").addEventListener("click", () => this._commit(localDayRange()));
    this._sync();
  }
}

export class EnergySiteHistoryCard extends RangeAwareCard {
  setConfig(config) {
    if (!config?.entities || !Array.isArray(config?.series) || !config.series.length) throw new Error("entities and a non-empty series list are required");
    this.config = { title: "Site and battery history", range_key: "energy-events", bucket_minutes: 5, show_cumulative_energy: true, ...config };
    if (Number(this.config.bucket_minutes) !== 5) throw new Error("Only 5-minute recorder statistics are currently supported");
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._renderShell();
  }
  getCardSize() { return 6; }
  async _load(force = false) {
    if (!this._hass || this._loading) return;
    const range = this._range(), now = new Date(), queryEnd = now > range.start && now < range.end ? now : range.end;
    const key = `${range.start.toISOString()}|${range.end.toISOString()}`;
    if (!force && key === this._key && Date.now() - (this._loadedAt || 0) < 60000) return;
    this._loading = true; this._error = null;
    try { this._series = await loadSeries(this._hass, this.config.entities, range.start, queryEnd, this.config.bucket_minutes); this._data = { ...range, queryEnd }; this._key = key; this._loadedAt = Date.now(); }
    catch (error) { this._error = error?.message || String(error); }
    finally { this._loading = false; this._render(); }
  }
  _renderShell() {
    this.shadowRoot.innerHTML = `<style>
      :host,ha-card{display:block;min-width:0;max-width:100%}ha-card{overflow:hidden}.head{display:flex;padding:18px 20px 5px;gap:12px}.titles{flex:1;min-width:0}.title{font-size:21px}.subtitle{color:var(--secondary-text-color);font-size:12px;margin-top:3px}.refresh{border:0;background:transparent;color:var(--secondary-text-color);font-size:20px;cursor:pointer}.legend{display:flex;flex-wrap:wrap;gap:7px 14px;padding:4px 20px 8px;font-size:12px;color:var(--secondary-text-color)}.key{display:inline-flex;align-items:center}.swatch{width:16px;height:3px;background:var(--c);margin-right:6px}.totals{padding:2px 20px 7px;font-size:12px}.wrap{position:relative;min-width:0;padding:0 8px 12px;overflow:hidden}.status{min-height:280px;display:grid;place-items:center;color:var(--secondary-text-color);text-align:center;padding:16px}svg{display:block;width:100%;max-width:100%;height:auto}
      @media(max-width:520px){.head,.legend,.totals{padding-left:12px;padding-right:12px}.title{font-size:18px}.wrap{padding-left:4px;padding-right:4px}}
      </style><ha-card><div class="head"><div class="titles"><div class="title">${escapeHtml(this.config.title)}</div><div class="subtitle">5-minute means · power in kW${this.config.show_cumulative_energy ? " · cumulative energy in kWh" : ""}</div></div><button class="refresh" aria-label="Refresh history">↻</button></div><div class="legend"></div><div class="totals"></div><div class="wrap"><div class="status">Loading energy history…</div></div></ha-card>`;
    this.shadowRoot.querySelector(".refresh").addEventListener("click", () => this._load(true));
  }
  _render() {
    const wrap = this.shadowRoot?.querySelector(".wrap"); if (!wrap) return;
    if (this._error) { wrap.innerHTML = `<div class="status">Could not load history.<br>${escapeHtml(this._error)}</div>`; return; }
    if (!this._data) return;
    const configured = this.config.series.map((item, index) => ({ color: item.color || ["#3b82f6", "#ef4444", "#f59e0b", "#14b8a6", "#8b5cf6"][index % 5], ...item, points: this._series[item.metric] || [] }));
    this.shadowRoot.querySelector(".legend").innerHTML = configured.map((item) => `<span class="key"><i class="swatch" style="--c:${escapeHtml(item.color)}"></i>${escapeHtml(item.label || item.metric)}</span>`).join("");
    const totals = configured.filter((item) => item.integrate !== false).map((item) => ({ ...item, energy: integratePower(item.points, this._data.start, this._data.queryEnd, this.config.bucket_minutes).total_kwh }));
    this.shadowRoot.querySelector(".totals").innerHTML = this.config.show_cumulative_energy ? totals.map((item) => `${escapeHtml(item.label || item.metric)}: <strong>${item.energy.toFixed(2)} kWh</strong>`).join(" · ") : "";
    const width = Math.round(wrap.getBoundingClientRect().width - 12); if (width < 180) return;
    const compact = width < 520, height = compact ? 280 : 330, left = compact ? 43 : 54, right = 12, top = 16, bottom = 38;
    const plotW = width - left - right, plotH = height - top - bottom, lo = this._data.start.getTime(), hi = this._data.end.getTime();
    const values = configured.flatMap((item) => item.points.map((point) => Number(point.v)).filter(Number.isFinite));
    const max = Math.max(1, ...values), x = (time) => left + (time - lo) / (hi - lo) * plotW, y = (value) => top + (max - Math.max(0, value)) / max * plotH;
    const grid = [], ticks = compact ? 3 : 6;
    for (let i = 0; i <= 4; i++) { const value = max * i / 4, yy = y(value); grid.push(`<line x1="${left}" y1="${yy}" x2="${left + plotW}" y2="${yy}" stroke="var(--divider-color)"/><text x="${left - 5}" y="${yy + 4}" text-anchor="end" fill="var(--secondary-text-color)" font-size="10">${value.toFixed(1)}</text>`); }
    for (let i = 0; i <= ticks; i++) { const time = lo + (hi - lo) * i / ticks, xx = x(time); grid.push(`<text x="${xx}" y="${height - 15}" text-anchor="middle" fill="var(--secondary-text-color)" font-size="10">${new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"}).format(new Date(time))}</text>`); }
    const paths = configured.map((item) => `<path d="${item.points.map((point, i) => `${i ? "L" : "M"} ${x(point.t).toFixed(1)} ${y(Number(point.v)).toFixed(1)}`).join(" ")}" fill="none" stroke="${escapeHtml(item.color)}" stroke-width="2"/>`).join("");
    wrap.innerHTML = `<svg role="img" aria-label="Site and battery power history" viewBox="0 0 ${width} ${height}"><g>${grid.join("")}</g>${paths}<text x="${left}" y="11" fill="var(--secondary-text-color)" font-size="10">kW</text></svg>`;
  }
}

export class EnergyEventExplorerCard extends RangeAwareCard {
  setConfig(config) {
    if (!config?.entities || !Array.isArray(config?.rules) || !config.rules.length) throw new Error("entities and a non-empty rules list are required");
    this.config = { title: "Energy event explorer", range_key: "energy-events", bucket_minutes: 5, ...config };
    if (Number(this.config.bucket_minutes) !== 5) throw new Error("Only 5-minute recorder statistics are currently supported");
    if (!this.shadowRoot) this.attachShadow({ mode: "open" }); this._renderShell();
  }
  getCardSize() { return 7; }
  async _load(force = false) {
    if (!this._hass || this._loading) return;
    const range = this._range(), now = new Date(), queryEnd = now > range.start && now < range.end ? now : range.end;
    const key = `${range.start.toISOString()}|${range.end.toISOString()}`;
    if (!force && key === this._key && Date.now() - (this._loadedAt || 0) < 60000) return;
    this._loading = true; this._error = null;
    try {
      const series = await loadSeries(this._hass, this.config.entities, range.start, queryEnd, this.config.bucket_minutes);
      this._results = evaluateEnergyEvents({ series, rules: this.config.rules, start: range.start, end: queryEnd, bucket_minutes: this.config.bucket_minutes });
      this._data = { ...range, queryEnd }; this._key = key; this._loadedAt = Date.now();
    } catch (error) { this._error = error?.message || String(error); }
    finally { this._loading = false; this._render(); }
  }
  _renderShell() {
    this.shadowRoot.innerHTML = `<style>
      :host,ha-card{display:block;min-width:0;max-width:100%}ha-card{overflow:hidden}.head{display:flex;padding:18px 20px 4px;gap:12px}.titles{min-width:0;flex:1}.title{font-size:21px}.subtitle{font-size:12px;color:var(--secondary-text-color);margin-top:3px}.refresh{border:0;background:transparent;color:var(--secondary-text-color);font-size:20px;cursor:pointer}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;padding:8px 20px}.stat{padding:9px 11px;border:1px solid var(--divider-color);border-radius:9px}.stat strong{display:block;font-size:18px}.timeline{padding:4px 20px 12px}.row{display:grid;grid-template-columns:minmax(120px,180px) 1fr;gap:9px;align-items:center;margin:8px 0}.label{font-size:12px;overflow:hidden;text-overflow:ellipsis}.track{height:16px;position:relative;border-radius:5px;background:var(--secondary-background-color);overflow:hidden}.event{position:absolute;height:100%;min-width:2px;background:var(--c);border-radius:3px}.events{padding:0 20px 16px}.events h3{font-size:14px;margin:8px 0}.events table{width:100%;border-collapse:collapse;font-size:12px}.events th,.events td{text-align:left;padding:6px;border-bottom:1px solid var(--divider-color)}.status{min-height:260px;display:grid;place-items:center;color:var(--secondary-text-color);text-align:center;padding:16px}.warning{font-size:11px;color:var(--warning-color,#f59e0b);padding:0 20px 10px}
      @media(max-width:520px){.head,.summary,.timeline,.events{padding-left:12px;padding-right:12px}.title{font-size:18px}.row{grid-template-columns:105px 1fr}.events table{font-size:11px}.optional{display:none}}
      </style><ha-card><div class="head"><div class="titles"><div class="title">${escapeHtml(this.config.title)}</div><div class="subtitle">Aligned 5-minute observations · missing required metrics are reported</div></div><button class="refresh" aria-label="Refresh events">↻</button></div><div class="body"><div class="status">Loading energy events…</div></div></ha-card>`;
    this.shadowRoot.querySelector(".refresh").addEventListener("click", () => this._load(true));
  }
  _render() {
    const body = this.shadowRoot?.querySelector(".body"); if (!body) return;
    if (this._error) { body.innerHTML = `<div class="status">Could not evaluate events.<br>${escapeHtml(this._error)}</div>`; return; }
    if (!this._data || !this._results) return;
    const totalEvents = this._results.reduce((sum, result) => sum + result.events.length, 0);
    const totalEnergy = this._results.reduce((sum, result) => sum + result.total_energy_kwh, 0);
    const skipped = this._results.reduce((sum, result) => sum + result.skipped_missing_buckets, 0);
    const lo = this._data.start.getTime(), hi = this._data.end.getTime(), span = hi - lo;
    const rows = this._results.map((result) => `<div class="row"><div class="label" title="${escapeHtml(result.label)}">${escapeHtml(result.label)}</div><div class="track">${result.events.map((event) => `<i class="event" title="${escapeHtml(result.label)}" style="--c:${escapeHtml(result.color)};left:${Math.max(0,(event.start-lo)/span*100)}%;width:${Math.max(.2,(event.end-event.start)/span*100)}%"></i>`).join("")}</div></div>`).join("");
    const eventRows = this._results.flatMap((result) => result.events.map((event) => ({ ...event, label: result.label }))).sort((a,b) => a.start-b.start);
    const formatter = new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
    body.innerHTML = `<div class="summary"><div class="stat"><strong>${totalEvents}</strong>events</div><div class="stat"><strong>${totalEnergy.toFixed(2)} kWh</strong>rule-linked export*</div><div class="stat"><strong>${skipped}</strong>missing-data buckets</div></div><div class="timeline">${rows || "No configured event rows"}</div><div class="warning">* Overlapping rules can count the same exported energy. ${skipped ? "Missing required observations were excluded; no values were inferred." : ""}</div><div class="events"><h3>Detected intervals</h3>${eventRows.length ? `<table><thead><tr><th>Event</th><th>Start</th><th>Duration</th><th class="optional">Energy</th></tr></thead><tbody>${eventRows.map((event) => `<tr><td>${escapeHtml(event.label)}</td><td>${formatter.format(new Date(event.start))}</td><td>${event.duration_minutes.toFixed(0)} min</td><td class="optional">${event.energy_kwh.toFixed(2)} kWh</td></tr>`).join("")}</tbody></table>` : `<div class="status">No qualifying events in this range.</div>`}</div>`;
  }
}

if (!customElements.get("energy-event-range-selector-card")) customElements.define("energy-event-range-selector-card", EnergyEventRangeSelectorCard);
if (!customElements.get("energy-site-history-card")) customElements.define("energy-site-history-card", EnergySiteHistoryCard);
if (!customElements.get("energy-event-explorer-card")) customElements.define("energy-event-explorer-card", EnergyEventExplorerCard);
window.customCards = window.customCards || [];
window.customCards.push(
  { type: "energy-event-range-selector-card", name: "Energy Event Range Selector", description: "Shared local date-time range selector for Energy Event Explorer cards" },
  { type: "energy-site-history-card", name: "Energy Site History", description: "Site and battery power history with integrated energy totals" },
  { type: "energy-event-explorer-card", name: "Energy Event Explorer", description: "Find and time configurable energy events with explicit missing-data reporting" },
);
