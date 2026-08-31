export const DEFAULT_BUCKET_MINUTES = 5;

const DEFAULT_METRICS = {
  export: "grid_export",
  soc: "battery_soc",
  discharge: "battery_discharge",
  charge: "battery_charge",
  charge_limit: "charge_limit",
  plan: "operating_plan",
  plan_active: "operating_plan_active",
  plan_blocks: "operating_plan_blocks",
};

export function localDayRange(reference = new Date()) {
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const end = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1);
  return { start, end };
}

export function validRange(start, end) {
  return start instanceof Date && end instanceof Date
    && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start;
}

export function shiftRangeByCalendarDays(start, end, days) {
  if (!validRange(start, end) || !Number.isInteger(days)) throw new Error("A valid range and integer day shift are required");
  const shiftedStart = new Date(start);
  const shiftedEnd = new Date(end);
  shiftedStart.setDate(shiftedStart.getDate() + days);
  shiftedEnd.setDate(shiftedEnd.getDate() + days);
  return { start: shiftedStart, end: shiftedEnd };
}

export function normalizeSeries(points = []) {
  if (!Array.isArray(points)) return [];
  return points.map((point) => ({
    t: point?.t instanceof Date ? point.t.getTime() : Number(point?.t),
    v: point?.v,
  })).filter((point) => Number.isFinite(point.t) && point.v !== null && point.v !== undefined)
    .sort((a, b) => a.t - b.t);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "on", "yes", "active", "1"].includes(normalized)) return true;
  if (["false", "off", "no", "inactive", "0"].includes(normalized)) return false;
  return null;
}

function clockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) throw new Error(`Invalid clock value: ${value}`);
  const hours = Number(match[1]), minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid clock value: ${value}`);
  return hours * 60 + minutes;
}

export function timeInWindows(timestamp, windows = []) {
  if (!windows.length) return true;
  const date = new Date(timestamp);
  const minute = date.getHours() * 60 + date.getMinutes();
  return windows.some((window) => {
    const start = clockMinutes(window.start), end = clockMinutes(window.end);
    if (start === end) return true;
    return end > start ? minute >= start && minute < end : minute >= start || minute < end;
  });
}

function requiredRoles(rule) {
  const optionalPlanRoles = [];
  if (rule.active !== undefined) optionalPlanRoles.push("plan_active");
  if (rule.min_blocks !== undefined) optionalPlanRoles.push("plan_blocks");
  switch (rule.type) {
    case "export_soc_headroom": return ["export", "soc"];
    case "discharge_while_exporting": return ["export", "discharge"];
    case "export_undercharge": return ["export", "soc", "charge", "charge_limit"];
    case "operating_plan": return ["plan", ...optionalPlanRoles];
    case "operating_plan_change": return ["plan"];
    case "tariff_overlap": return ["export"];
    default: throw new Error(`Unsupported event rule type: ${rule.type}`);
  }
}

function roleAlias(rule, role) {
  return rule.metrics?.[role] || DEFAULT_METRICS[role];
}

export function validateRules(rules) {
  if (!Array.isArray(rules) || !rules.length) throw new Error("At least one event rule is required");
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || !rule.id || !rule.type) throw new Error("Every rule requires id and type");
    if (ids.has(rule.id)) throw new Error(`Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    requiredRoles(rule);
    if (rule.type === "tariff_overlap" && (!Array.isArray(rule.tariff_windows) || !rule.tariff_windows.length)) {
      throw new Error(`tariff_overlap rule ${rule.id} requires tariff_windows`);
    }
    if (rule.tariff_windows) rule.tariff_windows.forEach((window) => {
      clockMinutes(window.start); clockMinutes(window.end);
    });
  }
  return true;
}

function valueAt(indexes, alias, timestamp) {
  const value = indexes.get(alias)?.get(timestamp);
  return value === undefined ? null : value;
}

function matchesRule(rule, values, previousValues, timestamp) {
  const exportKw = finiteNumber(values.export);
  const minExport = Number(rule.min_export_kw ?? 0.05);
  switch (rule.type) {
    case "export_soc_headroom": {
      const soc = finiteNumber(values.soc);
      return exportKw > minExport && soc < Number(rule.soc_below ?? 95);
    }
    case "discharge_while_exporting": {
      const discharge = finiteNumber(values.discharge);
      return exportKw > minExport && discharge > Number(rule.min_discharge_kw ?? 0.05);
    }
    case "export_undercharge": {
      const soc = finiteNumber(values.soc), charge = finiteNumber(values.charge), limit = finiteNumber(values.charge_limit);
      const fraction = Number(rule.max_charge_fraction ?? 0.8);
      return exportKw > minExport && soc < Number(rule.soc_below ?? 95) && charge < limit * fraction;
    }
    case "operating_plan": {
      const plans = Array.isArray(rule.plans) ? rule.plans.map(String) : [];
      if (plans.length && !plans.includes(String(values.plan))) return false;
      if (rule.active !== undefined && booleanValue(values.plan_active) !== Boolean(rule.active)) return false;
      if (rule.min_blocks !== undefined && finiteNumber(values.plan_blocks) < Number(rule.min_blocks)) return false;
      return true;
    }
    case "operating_plan_change":
      return previousValues && String(values.plan) !== String(previousValues.plan);
    case "tariff_overlap":
      return exportKw > minExport;
    default:
      return false;
  }
}

function closeEvent(event, result) {
  if (!event) return;
  event.duration_minutes = Math.round((event.end - event.start) / 60000 * 100) / 100;
  event.energy_kwh = Math.round(event.energy_kwh * 10000) / 10000;
  result.events.push(event);
  result.total_duration_minutes += event.duration_minutes;
  result.total_energy_kwh += event.energy_kwh;
}

export function evaluateEnergyEvents({ series, rules, start, end, bucket_minutes = DEFAULT_BUCKET_MINUTES }) {
  validateRules(rules);
  const startMs = start instanceof Date ? start.getTime() : Number(start);
  const endMs = end instanceof Date ? end.getTime() : Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("A valid evaluation range is required");
  const bucketMs = Number(bucket_minutes) * 60000;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) throw new Error("bucket_minutes must be positive");

  const indexes = new Map(Object.entries(series || {}).map(([alias, points]) => [
    alias,
    new Map(normalizeSeries(points).map((point) => [point.t, point.v])),
  ]));
  const timeline = [...new Set([...indexes.values()].flatMap((index) => [...index.keys()]))]
    .filter((time) => time >= startMs && time < endMs).sort((a, b) => a - b);
  const output = [];

  for (const rule of rules) {
    const required = requiredRoles(rule);
    const result = {
      rule_id: rule.id,
      label: rule.label || rule.id,
      type: rule.type,
      color: rule.color || "#7c4dff",
      events: [],
      qualifying_buckets: 0,
      skipped_missing_buckets: 0,
      total_duration_minutes: 0,
      total_energy_kwh: 0,
    };
    let open = null, previousValues = null, previousTimestamp = null;
    for (const timestamp of timeline) {
      const values = {};
      const roles = new Set([...required, "export", "plan_active", "plan_blocks"]);
      for (const role of roles) values[role] = valueAt(indexes, roleAlias(rule, role), timestamp);
      const missing = required.some((role) => values[role] === null);
      const inWindow = timeInWindows(timestamp, rule.tariff_windows || []);
      const qualifies = !missing && inWindow && matchesRule(rule, values, previousValues, timestamp);
      const bucketEnd = Math.min(timestamp + bucketMs, endMs);
      if (missing) result.skipped_missing_buckets += 1;
      if (qualifies) {
        result.qualifying_buckets += 1;
        const exportKw = Math.max(0, finiteNumber(values.export) || 0);
        const energy = exportKw * (bucketEnd - timestamp) / 3600000;
        const contiguous = open && previousTimestamp !== null && timestamp <= previousTimestamp + bucketMs;
        if (!contiguous) {
          closeEvent(open, result);
          open = { start: timestamp, end: bucketEnd, energy_kwh: 0, samples: 0 };
        }
        open.end = bucketEnd;
        open.energy_kwh += energy;
        open.samples += 1;
      } else {
        closeEvent(open, result);
        open = null;
      }
      previousValues = values;
      previousTimestamp = timestamp;
    }
    closeEvent(open, result);
    result.total_duration_minutes = Math.round(result.total_duration_minutes * 100) / 100;
    result.total_energy_kwh = Math.round(result.total_energy_kwh * 10000) / 10000;
    output.push(result);
  }
  return output;
}

export function integratePower(points, start, end, bucket_minutes = DEFAULT_BUCKET_MINUTES) {
  const lo = start instanceof Date ? start.getTime() : Number(start);
  const hi = end instanceof Date ? end.getTime() : Number(end);
  const bucketMs = Number(bucket_minutes) * 60000;
  let total = 0;
  const cumulative = [{ t: lo, v: 0 }];
  for (const point of normalizeSeries(points)) {
    if (point.t < lo || point.t >= hi) continue;
    const value = finiteNumber(point.v);
    if (value === null) continue;
    const bucketEnd = Math.min(point.t + bucketMs, hi);
    total += Math.max(0, value) * (bucketEnd - point.t) / 3600000;
    cumulative.push({ t: bucketEnd, v: total });
  }
  return { total_kwh: total, cumulative };
}
