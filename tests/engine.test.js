import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateEnergyEvents, integratePower, localDayRange, shiftRangeByCalendarDays, timeInWindows, validateRules } from "../src/engine.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/synthetic-day.json", import.meta.url), "utf8"));
const args = { series: fixture.series, start: new Date(fixture.start), end: new Date(fixture.end), bucket_minutes: 5 };

test("export with SOC headroom fails closed when SOC is missing", () => {
  const [result] = evaluateEnergyEvents({ ...args, rules: [{ id: "headroom", type: "export_soc_headroom", soc_below: 95 }] });
  assert.equal(result.qualifying_buckets, 2);
  assert.equal(result.skipped_missing_buckets, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].duration_minutes, 10);
  assert.equal(result.total_energy_kwh, 0.5);
});

test("detects discharge while exporting and undercharge", () => {
  const results = evaluateEnergyEvents({ ...args, rules: [
    { id: "discharge", type: "discharge_while_exporting", min_discharge_kw: 0.5 },
    { id: "undercharge", type: "export_undercharge", soc_below: 95, max_charge_fraction: 0.5 },
  ] });
  assert.equal(results[0].qualifying_buckets, 3);
  assert.equal(results[0].total_energy_kwh, 0.75);
  assert.equal(results[1].qualifying_buckets, 2);
});

test("detects matching plans and plan transitions", () => {
  const results = evaluateEnergyEvents({ ...args, rules: [
    { id: "plan", type: "operating_plan", plans: ["time_of_use"], active: true, min_blocks: 2 },
    { id: "changes", type: "operating_plan_change" },
  ] });
  assert.equal(results[0].qualifying_buckets, 3);
  assert.equal(results[1].qualifying_buckets, 2);
});

test("tariff windows support overnight ranges", () => {
  const at = (hour, minute) => new Date(2026, 0, 1, hour, minute).getTime();
  const windows = [{ start: "22:00", end: "06:00" }];
  assert.equal(timeInWindows(at(23, 0), windows), true);
  assert.equal(timeInWindows(at(5, 59), windows), true);
  assert.equal(timeInWindows(at(12, 0), windows), false);
});

test("integrates power using dimensionally correct kW-hours", () => {
  const result = integratePower(fixture.series.grid_export, new Date(fixture.start), new Date(fixture.end), 5);
  assert.equal(Number(result.total_kwh.toFixed(4)), 0.9167);
});

test("rule validation rejects unsupported and duplicate rules", () => {
  assert.throws(() => validateRules([{ id: "x", type: "unknown" }]), /Unsupported/);
  assert.throws(() => validateRules([
    { id: "x", type: "tariff_overlap", tariff_windows: [{ start: "10:00", end: "11:00" }] },
    { id: "x", type: "tariff_overlap", tariff_windows: [{ start: "10:00", end: "11:00" }] },
  ]), /Duplicate/);
  assert.throws(() => validateRules([{ id: "peak", type: "tariff_overlap" }]), /requires tariff_windows/);
});

test("missing optional plan qualifiers fail closed and are counted", () => {
  const series = { operating_plan: fixture.series.operating_plan };
  const [result] = evaluateEnergyEvents({ ...args, series, rules: [{ id: "plan", type: "operating_plan", plans: ["time_of_use"], active: true }] });
  assert.equal(result.qualifying_buckets, 0);
  assert.equal(result.skipped_missing_buckets, 6);
});

test("local day ranges preserve DST-length calendar days", () => {
  const previous = process.env.TZ; process.env.TZ = "America/Los_Angeles";
  const spring = localDayRange(new Date(2026, 2, 8, 12));
  const fall = localDayRange(new Date(2026, 10, 1, 12));
  assert.equal((spring.end - spring.start) / 3600000, 23);
  assert.equal((fall.end - fall.start) / 3600000, 25);
  const shifted = shiftRangeByCalendarDays(spring.start, spring.end, 1);
  assert.equal(shifted.start.getHours(), 0);
  if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
});
