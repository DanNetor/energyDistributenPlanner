/******************************
 * Energy-Distribution Planner
 * File: energyDistributionPlanner.js
 * Author: Daniel Frauenrath (daniel.frauenrath@outook.de)
 * Version: 2025-08
 *
 * Purpose:
 *   Plan household energy usage so that as many low-tariff (night) hours
 *   as possible are allocated to the main consumers (EV and heat pump),
 *   while considering PV forecast and battery SoC constraints.
 *
 * 🚀 TODO for Production (no logic change, just activation/config):
 *   - [ ] Set SET_PLANS = true to actually write pump setpoints via scheduler.
 *   - [ ] Verify state write permissions (setVal/setState targets exist).
 *   - [ ] Check summary text time suffix "(UTC)" vs. Europe/Berlin and adjust if needed.
 *   - [ ] Validate hour formatting for Grafana consumers (HH:mm:ss).
 ******************************/

// ==== IMPORTS & CONFIG ====
const fetch = require('node-fetch'); // ioBroker script adapter: load node-fetch
const TZ = 'Europe/Berlin';
const BYD_SOC_MIN_DAY = 50;
const BYD_SOC_MIN_NIGHT = 30;
const EV_MIN_SURPLUS_W = 2000;      // 1-phase 3.6kW: 2kW start threshold is sensible
const CHEAP_CUTOFF_EURKWH = 0.16;   // €/kWh threshold below which the EV charges at night
const BATTERY_PENALTY = 0.05;       // €/kWh estimated roundtrip cost when battery must be used
const SET_PLANS = false;            // true => schedules are actually applied (production)
const EV_TARGET_KWH = 12;           // target energy for the EV
const EV_CHARGE_POWER_KW = 3.6;     // assumed charge power (kW) – adjust to your setup

// ==== STATE PATHS ====
const ST = {
	pvPower:      'plenticore.0.devices.local.Pv_P',
	gridPower:    'plenticore.0.devices.local.HomeGrid_P',
	houseLoad:    'plenticore.0.devices.local.Home_P',
	bydSoc:       'plenticore.0.devices.local.battery.SoC',
	evConnected:  'evcc.0.loadpoints.1.connected',
	evModeSet:    'evcc.0.loadpoints.1.mode/set',     // pv | now | min | off
	evPlanEnergy: 'evcc.0.loadpoints.1.plan.energy',  // write JSON
	hpDhwSet:     'idm.0.modbus.dhw.setpoint',
	hpEnable:     'idm.0.modbus.enable',
	hpFlowOffset: 'idm.0.modbus.flow.offset',
	pricesJson:   '0_userdata.0.awattar.prices',
	forecastJson: '0_userdata.0.pv.forecast'
};

// ==== GRAFANA BASE ====
const GRAFANA_BASE = '0_userdata.0.EnergyDistriPlanner';

// ==== DETAIL LOGGING CONFIG & HELPERS ====
const DETAIL_BASE = `${GRAFANA_BASE}.details`;
const DETAIL_MAX = 9;           // ring buffer size
const DETAIL_LOGS = [];         // { ts, level, msg }

/**
 * Ensure state exists with a safe default.
 */
function ensureState(id, common = { type: 'string', read: true, write: true, def: '' }) {
	try {
		if (!existsState(id)) createState(id, common);
	} catch (e) {
		log(`⚠️ ensureState failed for ${id}: ${e}`, 'warn');
	}
}

/**
 * Safe write convenience wrapper.
 */
function setVal(id, value) {
	try {
		if (!existsState(id)) ensureState(id, { type: 'string', read: true, write: true, def: '' });
		setState(id, value, true);
	} catch (e) {
		log(`setVal: failed for ${id}: ${e}`, 'warn');
	}
}

/**
 * Safe read convenience wrapper (+optional JSON parse).
 */
function getVal(id, def = null, { json = false, trace = false } = {}) {
	try {
		const st = getState(id);
		if (!st || st.val === undefined || st.val === null) {
			const msg = `getVal: state missing/empty → ${id}`;
			trace ? log(`${msg}\n${new Error().stack}`, 'warn') : log(msg, 'warn');
			return def;
		}
		let v = st.val;
		if (json && typeof v === 'string') {
			try {
				v = JSON.parse(v);
			} catch (e) {
				log(`getVal: JSON parse error for ${id}: ${e}`, 'warn');
				return def;
			}
		}
		return v;
	} catch (e) {
		log(`getVal: unexpected error for ${id}: ${e}`, 'warn');
		return def;
	}
}

/**
 * Ensure detail states exist for Grafana-compatible, multi-line display.
 */
function ensureDetailStates() {
	ensureState(DETAIL_BASE, { type: 'string', read: true, write: true, def: '{}' });
	ensureState(`${DETAIL_BASE}.detailsJson`, { type: 'string', read: true, write: true, def: '[]' });
	ensureState(`${DETAIL_BASE}.detailsText`, { type: 'string', read: true, write: true, def: '' });
	ensureState(`${DETAIL_BASE}.lines`, { type: 'string', read: true, write: true, def: '' });
	for (let i = 1; i <= DETAIL_MAX; i++) {
		const n = String(i).padStart(2, '0');
		ensureState(`${DETAIL_BASE}.lines.line${n}`, { type: 'string', read: true, write: true, def: '' });
	}
}

/**
 * Detail logger:
 *  - writes to normal log
 *  - also pushes a compact entry into ring buffer (used for Grafana)
 */
function dlog(message, level = 'info') {
	try { log(message, level); } catch (e) { /* ignore */ }
	try {
		DETAIL_LOGS.push({ ts: new Date().toISOString(), level: String(level || 'info'), msg: String(message) });
		if (DETAIL_LOGS.length > DETAIL_MAX) DETAIL_LOGS.splice(0, DETAIL_LOGS.length - DETAIL_MAX);
	} catch (e) { /* ignore */ }
}

/**
 * Normalize a message line for compact multi-line display.
 */
function cleanForLine(raw) {
	if (!raw) return '';
	let s = String(raw);
	// Strip leading "[time] LEVEL:" parts
	s = s.replace(/^\[[^\]]*\]\s*[A-Z]+:\s*/u, '');
	// Shorten verbose sources
	s = s.replace(/(PV-?Forecast)\s*\([^)]*\)/iu, '$1');
	// Normalize times like "H : mm : ss" -> "HH:mm:ss"
	s = s.replace(/(\b\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/g,
		(m, hh, mm, ss) => `${String(hh).padStart(2, '0')}:${mm}${ss ? `:${ss}` : ''}`);
	// Ensure single space after these labels
	s = s.replace(
		/(Günstige Nachtstunden|PV-?Forecast|PV-Gesamtprognose|Billigste Nachtstunden|Wärmepumpe [^:]+|EV|Nacht \(billig\)):/gu,
		'$1: '
	);
	// Squash duplicate spaces
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s;
}

/**
 * Flush ring buffer into states:
 *  - .detailsJson: JSON array
 *  - .detailsText: newline-joined text
 *  - .lines.lineXX: one per line for Grafana single stat panels
 */
function flushDetailStates() {
	try {
		const arr = DETAIL_LOGS.slice(-DETAIL_MAX);
		setVal(`${DETAIL_BASE}.detailsJson`, JSON.stringify(arr));
		const textClean = arr.map(x => cleanForLine(x.msg)).join('\n');
		setVal(`${DETAIL_BASE}.detailsText`, textClean);
		for (let i = 1; i <= DETAIL_MAX; i++) setVal(`${DETAIL_BASE}.lines.line${String(i).padStart(2, '0')}`, '');
		arr.forEach((x, idx) => setVal(`${DETAIL_BASE}.lines.line${String(idx + 1).padStart(2, '0')}`, cleanForLine(x.msg)));
	} catch (e) { /* ignore */ }
}

// ==== HELPERS ====
function eurMWhToEurKWh(x) { return x / 1000; }
function isNight(h) { return (h >= 22 || h < 6); }
function localHour(ms) { return new Date(ms).toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }); }
function parseNum(x) { if (x === null || x === undefined) return NaN; return Number(String(x).replace(',', '.')); }

/**
 * Get hour (0..23) in local timezone from a variety of timestamp inputs.
 */
function hourLocal(ts) {
	let d;
	if (ts instanceof Date) d = ts;
	else if (!isNaN(ts)) d = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts));
	else d = new Date(ts);
	if (isNaN(d.getTime())) return NaN;
	return Number(d.toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }));
}

/**
 * Format timestamp as dd.MM.yyyy HH:mm:ss in DE locale, TZ Europe/Berlin.
 */
function formatDateDE(ts) {
	const d = new Date(ts);
	return d.toLocaleString('de-DE', {
		timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit'
	});
}

function fmtTimeHM(d) { return d.toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); }
function fmtTimeHMS(d) { return d.toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

// ==== PREPARE STATES ====
ensureState(ST.pricesJson);
ensureState(ST.forecastJson);

/**
 * Ensure Grafana states for hourly tables and series exist.
 */
function ensureGrafanaStates() {
	ensureState(GRAFANA_BASE, { type: 'string', read: true, write: true, def: '{}' });
	ensureState(`${GRAFANA_BASE}.tableJsonLong`, { type: 'string', read: true, write: true, def: '[]' });
	ensureState(`${GRAFANA_BASE}.summaryText`, { type: 'string', read: true, write: true, def: '' });

	for (let h = 0; h < 24; h++) {
		const HH = String(h).padStart(2, '0');
		ensureState(`${GRAFANA_BASE}.prices.hour${HH}`, { type: 'number', read: true, write: true, def: 0 });
		ensureState(`${GRAFANA_BASE}.prices_ct.hour${HH}`, { type: 'number', read: true, write: true, def: 0 });
		ensureState(`${GRAFANA_BASE}.forecastWh.hour${HH}`, { type: 'number', read: true, write: true, def: 0 });

		ensureState(`${GRAFANA_BASE}.table.hour${HH}.start`, { type: 'string', read: true, write: true, def: '' });
		ensureState(`${GRAFANA_BASE}.table.hour${HH}.end`, { type: 'string', read: true, write: true, def: '' });
		ensureState(`${GRAFANA_BASE}.table.hour${HH}.price_ct`, { type: 'number', read: true, write: true, def: 0 });
		ensureState(`${GRAFANA_BASE}.table.hour${HH}.forecast_kwh`, { type: 'number', read: true, write: true, def: 0 });
		ensureState(`${GRAFANA_BASE}.table.hour${HH}.cheap`, { type: 'boolean', read: true, write: true, def: false });
	}
}

// ==== DATA FETCH ====
/**
 * Fetch next 24h aWATTar prices in €/kWh and persist raw array to state.
 */
async function getPrices24h() {
	const url = 'https://api.awattar.de/v1/marketdata';
	const res = await fetch(url);
	const js = await res.json();
	const now = Date.now();

	const items = (js.data || [])
		.filter(x => x.start_timestamp >= now && x.start_timestamp < now + 24 * 3600 * 1000)
		.map(x => ({
			start: x.start_timestamp,
			end: x.end_timestamp,
			price: eurMWhToEurKWh(x.marketprice)
		}));

	setVal(ST.pricesJson, JSON.stringify(items));
	return items;
}

/**
 * Build 24-slot PV forecast (Wh) from Plenticore "day1/2.power" hourly series.
 * Falls back to zeros if no known forecast structure is available.
 */
function getPvForecast24h() {
	const baseCandidates = ['plenticore.0.forecast.day2.power', 'plenticore.0.forecast.day1.power'];
	let base = null;

	for (const cand of baseCandidates) {
		if (existsState(`${cand}.1h.time`) || existsState(`${cand}.2h.time`)) { base = cand; break; }
	}
	if (!base) {
		dlog('☀️ PV-Forecast: 0 sun-hours mapped.', 'info');
		const empty = new Array(24).fill(0);
		setVal(ST.forecastJson, JSON.stringify(empty));
		return empty;
	}

	const arrWh = new Array(24).fill(0);
	let found = 0;

	for (let k = 1; k <= 24; k++) {
		const prefix = `${base}.${k}h`;
		if (!existsState(`${prefix}.time`)) continue;

		const t = getVal(`${prefix}.time`);
		if (!t) continue;

		const h = hourLocal(t);
		if (isNaN(h)) continue;

		const idHigh = `${prefix}.power_high`;
		const idPow = `${prefix}.power`;
		const idUsed = existsState(idHigh) ? idHigh : (existsState(idPow) ? idPow : null);
		if (!idUsed) continue;

		const pObj = getObject(idUsed);
		const unit = (pObj && pObj.common && pObj.common.unit ? String(pObj.common.unit).toLowerCase() : '');

		let v = parseNum(getVal(idUsed));
		if (isNaN(v)) continue;
		if (unit === 'kwh') v *= 1000; // convert to Wh

		if (h >= 0 && h <= 23) {
			arrWh[h] += Math.max(0, v);
			found++;
		}
	}

	dlog(`☀️ PV-Forecast: ${found} sun-hours mapped.`, 'info');
	setVal(ST.forecastJson, JSON.stringify(arrWh));
	return arrWh;
}

// ==== CORE SCORING ====
/**
 * Price scoring for an hour:
 *   - Base price
 *   - Battery penalty if forecast too low
 *   - Small bonus if SoC above guard level
 */
function hourScore(h, price, pvWh, bydSoc) {
	const pvKWh = Math.max(0, pvWh) / 1000;
	const socGuard = (isNight(h) ? BYD_SOC_MIN_NIGHT : BYD_SOC_MIN_DAY);
	const needBattery = (pvKWh < 1.5);
	const penalty = needBattery ? BATTERY_PENALTY : 0;
	return price + penalty + (bydSoc < socGuard ? 0.02 : 0);
}

// ==== CHEAPEST NIGHT (for log only) ====
/**
 * Return the two cheapest night hours (next 24h), sorted by time for display.
 */
function twoCheapestNight(prices) {
	const nowLocal = new Date().toLocaleString('en-US', { timeZone: TZ });
	const now = new Date(nowLocal).getTime();
	const until = now + 24 * 3600 * 1000;

	const picked = prices
		.map(p => ({ ...p, h: parseInt(localHour(p.start), 10) }))
		.filter(p => p.start >= now && p.start < until && isNight(p.h))
		.sort((a, b) => a.price - b.price)
		.slice(0, 2);

	// Display in chronological order like the old log format
	return picked.sort((a, b) => a.start - b.start);
}

// ==== PLANNER ====
/**
 * Pick indices of N cheapest hours according to score() with SoC & PV guard.
 */
function pickCheapestHours(prices, forecast, count) {
	const soc = Number(getVal(ST.bydSoc, 0)) || 0;
	const pairs = prices.map((p, i) => {
		const h = parseInt(localHour(p.start), 10);
		return { i, score: hourScore(h, p.price, forecast?.[i] || 0, soc) };
	});
	pairs.sort((a, b) => a.score - b.score);
	return pairs.slice(0, count).map(x => x.i).sort((a, b) => a - b);
}

/**
 * Build EV plan based on cheapest night hours and PV threshold.
 * Returns { value, time, hours } or null if no night charge is planned.
 */
function buildEvPlan(prices, forecast) {
	const iTresholdNightLoad = 12000; // Wh threshold to decide PV is "enough"
	const pvSumWh = (forecast || []).reduce((a, b) => a + (b || 0), 0);

	// Count "cheap night hours" for log (for info only)
	const cheapNight = prices.filter(p => {
		const h = parseInt(localHour(p.start), 10);
		return isNight(h) && (p.price < CHEAP_CUTOFF_EURKWH);
	});

	dlog(`📊 PV-Gesamtprognose: ${(pvSumWh / 1000).toFixed(2)} kWh (Schwelle: ${(iTresholdNightLoad / 1000).toFixed(1)} kWh)`);
	dlog(`💰 Günstige Nachtstunden (<${CHEAP_CUTOFF_EURKWH} €/kWh): ${cheapNight.length} Stück`);

	// Number of hours required to meet EV target energy
	const hoursNeeded = Math.max(1, Math.ceil(EV_TARGET_KWH / Math.max(0.1, EV_CHARGE_POWER_KW)));

	// All night hours (next 24h), sorted ascending by price
	const now = Date.now();
	const until = now + 24 * 3600e3;
	const nightSorted = prices
		.filter(p => {
			const h = parseInt(localHour(p.start), 10);
			return p.start >= now && p.start < until && isNight(h);
		})
		.sort((a, b) => a.price - b.price);

	// Pick the cheapest 'hoursNeeded' slots, then sort by time for display
	const picked = nightSorted.slice(0, hoursNeeded).sort((a, b) => a.start - b.start);

	// Decide: only plan night charging if the PV forecast is too low
	if (picked.length === hoursNeeded && pvSumWh < iTresholdNightLoad) {
		const startTs = picked[0].start;
		const endTs = picked[picked.length - 1].end;

		const startStr = new Date(startTs).toLocaleString('de-DE', {
			timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
		});
		const endStr = new Date(endTs).toLocaleString('de-DE', {
			timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
		});

		const hoursCount = picked.length;
		const hoursLabel = hoursCount === 1 ? 'Stunde' : 'Stunden';

		dlog(`🔋 Nachtladung geplant: ${EV_TARGET_KWH} kWh von ${startStr} bis ${endStr} (${hoursCount} ${hoursLabel})`);
		return { value: EV_TARGET_KWH, time: new Date(endTs).toISOString(), hours: hoursCount };
	} else {
		if (pvSumWh >= iTresholdNightLoad) dlog('✅ Genug PV-Ertrag erwartet → Laden am Tag per PV.');
		if (picked.length < hoursNeeded) dlog('⚠️ Nachtladung nicht sinnvoll → zu wenige Nachtstunden verfügbar.');
	}

	dlog('❌ Keine Nachtladung geplant.');
	return null;
}

/**
 * Heat pump plan: pick cheap hours for DHW (2h) and space heating (2h).
 */
function buildHpPlan(prices, forecast) {
	const dhwHours = pickCheapestHours(prices, forecast, 2);
	const heatHours = pickCheapestHours(prices, forecast, 2);
	return { dhwHours, heatHours };
}

// ==== APPLY (guards) ====
/**
 * Persist EV plan JSON for EVCC if the state exists.
 */
function applyEvPlan(plan) {
	if (!plan) return;
	if (existsState(ST.evPlanEnergy)) setState(ST.evPlanEnergy, JSON.stringify(plan), true);
}

/**
 * Log heat pump slots and (optionally) schedule temp offsets in cheap hours.
 */
function applyHpPlan(plan) {
	const pricesStr = getVal(ST.pricesJson, '[]');
	let pricesArr = [];
	try { pricesArr = JSON.parse(pricesStr) || []; } catch (e) { pricesArr = []; }

	const hhPrice = i => {
		if (i == null || !pricesArr[i]) return '';
		const h = parseInt(localHour(pricesArr[i].start ?? Date.now()), 10);
		const hhmm = (isNaN(h) ? '' : String(h).padStart(2, '0')) + ':00';
		const priceCt = (pricesArr[i].price * 100).toFixed(1);
		return `${hhmm} (${priceCt} ct/kWh)`; // legacy format for display
	};

	const slotsFrom = (indices) => (indices || [])
		.map(i => {
			const idx = Number(i);
			const p = pricesArr[idx];
			if (!p) return null;
			const startNum = typeof p.start === 'number' ? p.start : Number(p.start);
			return {
				idx,
				start: isNaN(startNum) ? 0 : startNum,
				hour: parseInt(localHour(startNum), 10),
				priceCt: (Number(p.price) * 100).toFixed(1)
			};
		})
		.filter(Boolean)
		.sort((a, b) => a.start - b.start); // ascending by time

	const fmt = s => {
		const dt = new Date(s.start);
		const date = dt.toLocaleDateString('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit' }); // "dd.MM"
		const time = dt.toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); // "HH:mm"
		return `${date} ${time} (${s.priceCt} ct/kWh)`;
	};
	const dhwList = slotsFrom(plan?.dhwHours).map(fmt).join(', ');
	const heatList = slotsFrom(plan?.heatHours).map(fmt).join(', ');

	dlog(`🔥 Wärmepumpe Warmwasser (2h): ${dhwList || 'keine'}.`);
	dlog(`🔥 Wärmepumpe Heizen (2h): ${heatList || 'keine'}.`);

	if (SET_PLANS) {
		// DHW: raise setpoint at slot start, revert after ~90 minutes
		plan.dhwHours.forEach(idx => {
			const slot = pricesArr[idx];
			if (!slot) return;
			const t = slot.start;
			const cur = Number(getVal(ST.hpDhwSet, 0)) || 0;
			schedule(new Date(t), () => setVal(ST.hpDhwSet, cur + 5));
			schedule(new Date(t + 90 * 60 * 1000), () => setVal(ST.hpDhwSet, cur));
		});

		// Space heating: increase flow offset by +3°C during slot, revert after 2h
		plan.heatHours.forEach(idx => {
			const slot = pricesArr[idx];
			if (!slot) return;
			const t = slot.start;
			schedule(new Date(t), () => setVal(ST.hpFlowOffset, +3));
			schedule(new Date(t + 2 * 60 * 60 * 1000), () => setVal(ST.hpFlowOffset, 0));
		});
	}
}

// ==== SUMMARY ====
/**
 * Build a compact summary text for dashboards.
 * Note: EV summary prints "(UTC)" suffix historically; verify if desired.
 */
function buildSummaryText(prices, forecast, evPlan, cheapNightDetailed) {
	const pvKWh = (forecast.reduce((a, b) => a + (b || 0), 0) / 1000).toFixed(2);
	const minP = (Math.min(...prices.map(p => p.price)) * 100).toFixed(1);
	const maxP = (Math.max(...prices.map(p => p.price)) * 100).toFixed(1);
	const cheapN = cheapNightDetailed.length;

	const evStr = evPlan
		? `EV: ${evPlan.value} kWh bis ${new Date(evPlan.time).toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })} (UTC)`
		: 'EV: keine Nachtladung';

	const cheapStr = cheapN
		? `Nacht (billig): ${cheapNightDetailed.map(x =>
			`${formatDateDE(x.start).slice(11, 16)} ${(x.price * 100).toFixed(1)} ct`
		).join(', ')}`
		: 'Nacht (billig): keine';

	return `PV: ${pvKWh} kWh • Preis: ${minP}–${maxP} ct/kWh • ${evStr} • ${cheapStr}`;
}

// ==== STORE (Long-Format + hourly series) ====
/**
 * Persist a long table (for Grafana JSON) and per-hour series.
 */
function storeGrafanaData(prices, forecast, pvSumKWh, cheapNightCount, evPlan, hpPlan, bydSoc, pvNow, gridNow, houseLoad) {
	const rows = prices.map((p, i) => {
		const h = parseInt(localHour(p.start), 10);
		const startStr = formatDateDE(p.start);
		const endStr = formatDateDE(p.end);
		const cheap = isNight(h) && (p.price < CHEAP_CUTOFF_EURKWH);
		const fWh = forecast[i] || 0;
		return {
			index: i, hourLocal: h, startUnix: p.start, endUnix: p.end,
			start: startStr, end: endStr, price_eur_kwh: p.price,
			price_ct_kwh: +(p.price * 100).toFixed(2),
			forecast_wh: fWh, forecast_kwh: +(fWh / 1000).toFixed(3),
			isNight: isNight(h), isCheapNight: cheap
		};
	});

	const tableLong = [];
	const pad = n => String(n).padStart(2, '0');
	for (const r of rows) {
		tableLong.push({ Zeit: r.start, Feld: 'Preis (ct/kWh)', Wert: r.price_ct_kwh, Stunde: `${pad(r.hourLocal)}:00:00` });
		tableLong.push({ Zeit: r.start, Feld: 'Forecast (kWh)', Wert: r.forecast_kwh, Stunde: `${pad(r.hourLocal)}:00:00` });
		tableLong.push({ Zeit: r.start, Feld: 'Günstige Nacht', Wert: r.isCheapNight ? 'Ja' : 'Nein', Stunde: `${pad(r.hourLocal)}:00:00` });
	}

	const dailyData = {
		timestamp: new Date().toISOString(),
		timezone: TZ,
		cheapNightCutoff_EURkWh: CHEAP_CUTOFF_EURKWH,
		cheapNightCount,
		forecastKWhTotal: +pvSumKWh.toFixed(2),
		evPlan: evPlan || {},
		hpPlan: hpPlan || {},
		bydSoc, pvPowerNow_W: pvNow, gridPowerNow_W: gridNow, houseLoadNow_W: houseLoad
	};

	setVal(GRAFANA_BASE, JSON.stringify(dailyData));
	setVal(`${GRAFANA_BASE}.tableJsonLong`, JSON.stringify(tableLong));

	for (let i = 0; i < 24; i++) {
		const HH = String(i).padStart(2, '0');
		const r = rows[i] || { price_eur_kwh: 0, price_ct_kwh: 0, forecast_wh: 0, forecast_kwh: 0, start: '', end: '', isCheapNight: false };

		setVal(`${GRAFANA_BASE}.prices.hour${HH}`, r.price_eur_kwh);
		setVal(`${GRAFANA_BASE}.prices_ct.hour${HH}`, r.price_ct_kwh);
		setVal(`${GRAFANA_BASE}.forecastWh.hour${HH}`, r.forecast_wh);

		setVal(`${GRAFANA_BASE}.table.hour${HH}.start`, r.start);
		setVal(`${GRAFANA_BASE}.table.hour${HH}.end`, r.end);
		setVal(`${GRAFANA_BASE}.table.hour${HH}.price_ct`, r.price_ct_kwh);
		setVal(`${GRAFANA_BASE}.table.hour${HH}.forecast_kwh`, r.forecast_kwh);
		setVal(`${GRAFANA_BASE}.table.hour${HH}.cheap`, r.isCheapNight);
	}

	// No extra "long" logger here – keep the compact legacy log clean
}

// ==== MAIN ====
/**
 * Full 24h planning routine:
 *  - ensure states
 *  - fetch prices & build forecast
 *  - compute EV & HP plans
 *  - persist summary + Grafana data
 *  - flush detail logs
 */
async function plan24h() {
	try {
		ensureGrafanaStates();
		ensureDetailStates();

		const prices = await getPrices24h();

		// Legacy-style line for "two cheapest night hours" (with seconds & ct/kWh)
		const best2 = twoCheapestNight(prices);
		if (best2.length) {
			const nice = best2.map(p => {
				const t = `${new Date(p.start).toLocaleDateString('de-DE', { timeZone: TZ })}, ${fmtTimeHMS(new Date(p.start))}`;
				const ct = (p.price * 100).toFixed(1);
				return `${t} → ${ct} ct/kWh`;
			}).join(' | ');
			dlog('💤 Billigste Nachtstunden: ' + nice);
		}

		const forecast = getPvForecast24h();

		const pvSumWh = (forecast || []).reduce((a, b) => a + (b || 0), 0);
		const pvSumKWh = pvSumWh / 1000;
		const cheapNightCount = prices.filter(p => {
			const h = parseInt(localHour(p.start), 10);
			return isNight(h) && (p.price < CHEAP_CUTOFF_EURKWH);
		}).length;

		const evPlan = buildEvPlan(prices, forecast);
		const hpPlan = buildHpPlan(prices, forecast);

		// Heat pump: log planned slots & (optionally) schedule setpoints
		applyHpPlan(hpPlan);

		const bydSoc = Number(getVal(ST.bydSoc, 0)) || 0;
		const pvNow = parseNum(getVal(ST.pvPower, 0)) || 0;
		const gridNow = parseNum(getVal(ST.gridPower, 0)) || 0;
		const houseNow = parseNum(getVal(ST.houseLoad, 0)) || 0;

		// Summary line
		const cheapNightDetailed = best2.map(x => ({ start: x.start, price: x.price }));
		const summary = buildSummaryText(prices, forecast, evPlan, cheapNightDetailed);
		setVal(`${GRAFANA_BASE}.summaryText`, summary);

		// Persist EV plan
		applyEvPlan(evPlan);

		// Persist Grafana-friendly data
		storeGrafanaData(prices, forecast, pvSumKWh, cheapNightCount, evPlan, hpPlan, bydSoc, pvNow, gridNow, houseNow);

		// Flush detail ring buffer to states
		flushDetailStates();

	} catch (e) {
		flushDetailStates();
		log('❌ Planungsfehler: ' + e, 'error');
	}
}

// ==== SCHEDULER (run hourly at :10) ====
// Timestamp helpers for scheduler log
function pad2(n) { return String(n).padStart(2, '0'); }
function ts(d = new Date()) {
	return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function prependDetails(line) {
	const id = `${DETAIL_BASE}.detailsText`;
	const prev = (getVal(id, '') || '');
	setVal(id, line + (prev ? '\n' + prev : ''));
}

// Plan 10 minutes after every full hour
dlog('📅 Scheduler geplant: Ausführung 10 Minuten nach jeder vollen Stunde.');
schedule('10 * * * *', function () {
	const line = `🕒 Scheduler ausgelöst - ${ts()}`;
	dlog(line);
	plan24h().then(() => prependDetails(line));
});

// Initial run once at script start
plan24h();