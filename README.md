# Dokumentation: Energy-Distribution Planner

> **Kurzfassung:** Der Energy-Distribution Planner optimiert den Energieeinsatz eines Haushalts mit PV-Anlage und Batteriespeicher anhand variabler Börsenstrompreise (aWATTar). Hauptverbraucher sind E-Auto (EV) und Wärmepumpe (WP). Preise, PV-Forecast und Batteriestand werden kombiniert, um Lade-/Heizzeiten kostenoptimal zu planen. Ergebnisse werden in ioBroker-States geschrieben, via InfluxDB geloggt und in Grafana visualisiert.

---

## 1 Einleitung

Dieses Projekt optimiert den Energieverbrauch eines Haushalts mit Photovoltaikanlage und Batteriespeicher anhand der variablen Börsenstrompreise. Ziel ist es, möglichst viele günstige (Nacht-)Stunden den Hauptverbrauchern – **elektrisches Fahrzeug (EV)** und **Wärmepumpe (WP)** – zuzuweisen und gleichzeitig die PV-Erzeugung und den Batteriestand zu berücksichtigen.

- **Preisdaten**: via [aWATTar API](https://api.awattar.de/v1/marketdata) – EPEX-Spotpreise der nächsten 24 Stunden (kostenfrei, tägliche Aktualisierung gegen ~14 Uhr; vgl. Hinweise im LogicMachine-Forum).  
- **PV-Forecast**: über den **Plenticore-Adapter** (KOSTAL-Wechselrichter).  
- **Ausführung**: JavaScript-Routine im ioBroker – **alle 60 Minuten** jeweils **10 Minuten nach voller Stunde**.  
- **Persistenz/Visualisierung**: Speicherung in ioBroker-States → InfluxDB → Grafana (Tabellen/Logs).

---

## 2 Systemübersicht

### 2.1 Hardware und Energiesystem

- **PV-Anlage**: 8,82 kWp installierte Leistung  
- **Batteriespeicher**: 10 kWh nutzbare Kapazität  
- **Hauptverbraucher**: Wallbox (EV) und Wärmepumpe (WP)  
- **Netzanschluss**: variabler Bezug/Einspeisung nach Börsenpreisen

### 2.2 Software-Komponenten

| Komponente | Aufgabe |
|---|---|
| **ioBroker** | Zentrale Automationsplattform. Das Skript `energyDistributionPlanner.js` läuft im Script-Adapter und nutzt Adapter zum Lesen/Schreiben von Zuständen. |
| **Adapter „Plenticore“** | Liest aktuelle Leistungswerte und **PV-Forecast** aus dem KOSTAL-Wechselrichter. Forecast kombiniert Standort/Wetterdaten und liefert je Sonnenstunde erwartete Leistung. |
| **Adapter „evcc“ (zukünftig)** | Open-Source HEMS zur **intelligenten EV-Ladung** (Überschuss, dynamische Tarife, Modi). Integration vorbereitet, Setpoints noch nicht produktiv. |
| **Modbus-Adapter** | Geplante Ansteuerung der Wärmepumpe via Modbus-Register. Bei iDM muss **Modbus TCP** aktiviert werden („Gebäudeleittechnik → Modbus TCP“). Vorsicht: Viele Register werden im EEPROM gespeichert → **sparsam schreiben**. |
| **InfluxDB** | Persistenz aller relevanten Zustände. |
| **Grafana** | Visualisierung (Day-Ahead-Planung als Tabelle, Log-Panel). |
| **Sonstige** | Hilfszustände unter `0_userdata.0.EnergyDistriPlanner` als Datendrehscheibe. |

### 2.3 Datenquellen (Details)

- **aWATTar Preisfeed** – stündliche Börsenpreise der kommenden 24 Stunden als JSON (Felder u. a. `start_timestamp`, `end_timestamp`, `marketprice` in **€/MWh**). Abfrage via **HTTP GET** auf `https://api.awattar.de/v1/marketdata`.  
- **PV-Forecast (Plenticore)** – Adapter stellt u. a. `plenticore.0.forecast.dayX.power` bereit (z. B. `power_high` / `power`). Werte je Stunde werden in **Wh**/ **kWh** gemappt.  
- **evcc** – Herstellerunabhängiges Energiemanagement für EV-Laden; Schwerpunkte: PV-Überschuss, dynamische Tarife, smarte Modi; >100 Wallboxen/Fahrzeugmodelle unterstützt. Dient hier als Schnittstelle zur Wallbox.  
- **Wärmepumpe via Modbus** – iDM-Geräte: Modus **Modbus TCP** aktivieren (Navigator „Gebäudeleittechnik“). Beim Lesen von Floats ggf. **Byte-Swap (word)** beachten. Integration derzeit **noch nicht umgesetzt**.

---

## 3 Funktionsweise des Skripts

Das Skript `energyDistributionPlanner.js` besteht aus mehreren, logisch getrennten Modulen.

### 3.1 Grundkonfiguration und Konstanten

- **Zeitzone**: `Europe/Berlin`  
- **Batterie-SoC-Grenzen**: `BYD_SOC_MIN_DAY = 50` %, `BYD_SOC_MIN_NIGHT = 30` %  
- **EV-Überschussstart**: `EV_MIN_SURPLUS_W = 2000` W  
- **Günstig-Schwelle**: `CHEAP_CUTOFF_EURKWH = 0.16` €/kWh  
- **Batterie-Penalty**: `BATTERY_PENALTY = 0.05` €/kWh (Roundtrip-Verluste)  
- **Schreibmodus**: `SET_PLANS = false` (für Tests; **Produktiv: true**)  
- **EV-Ziel & Leistung**: `EV_TARGET_KWH = 12`, `EV_CHARGE_POWER_KW = 3.6`

```js
// ==== IMPORTS & CONFIG ====
const fetch = require('node-fetch');
const TZ = 'Europe/Berlin';

const BYD_SOC_MIN_DAY = 50;
const BYD_SOC_MIN_NIGHT = 30;
const EV_MIN_SURPLUS_W = 2000;
const CHEAP_CUTOFF_EURKWH = 0.16;
const BATTERY_PENALTY = 0.05;

const SET_PLANS = false; // TODO (prod): true
const EV_TARGET_KWH = 12;
const EV_CHARGE_POWER_KW = 3.6;

// Beispielhafte Pfade (Auszug)
const ST = {
  pricesJson: '0_userdata.0.EnergyDistriPlanner.pricesJson',
  forecastJson: '0_userdata.0.EnergyDistriPlanner.forecastJson',
  tableJsonLong: '0_userdata.0.EnergyDistriPlanner.tableJsonLong',
  detailsText: '0_userdata.0.EnergyDistriPlanner.detailsText',
  evPlanJson: 'evcc.0.loadpoints.1.plan.energy'
};
```

### 3.2 Sicherheits-/Hilfsfunktionen

- `ensureState(id, common)` – legt fehlende States mit Defaults an.  
- `setVal(id, value)` / `getVal(id, parseJson)` – gekapseltes Schreiben/Lesen.  
- `dlog(msg)` – schreibt ins ioBroker-Log **und** in einen Ringpuffer (für Grafana-Logs).  
- `flushDetailStates()` – schiebt Ringpuffer in `detailsJson`, `detailsText`, `lines.lineXX`.

### 3.3 Datenbeschaffung

- `getPrices24h()` – lädt aWATTar-Preise, filtert ab „jetzt“, wandelt **€/MWh → €/kWh** um und speichert als JSON in `pricesJson`.

```js
const fetchPrices = async () => {
  const url = 'https://api.awattar.de/v1/marketdata';
  const res = await fetch(url);
  const data = await res.json();

  // €/MWh → €/kWh
  const items = (data?.data || []).map(x => ({
    start: x.start_timestamp,
    end: x.end_timestamp,
    eur_per_kwh: x.marketprice / 1000
  }));

  return items;
};
```

- `getPvForecast24h()` – liest `plenticore.0.forecast.dayX.power`, mappt je Stunde Zeitstempel → **lokale Stunde** und Leistung → **Wh**, protokolliert die erkannten Sonnenstunden.

### 3.4 Bewertung und Planung

- `hourScore()` – Score je Stunde anhand Preis, Batterie-Penalty und SoC-Bonus.  
- `twoCheapestNight()` – zwei günstigste **Nachtstunden (22–6 Uhr)** für die Log-Ausgabe.  
- `pickCheapestHours(prices, forecast, count)` – wählt `count` Stunden mit bestem Score (unter Berücksichtigung des Batteriestands).  
- `buildEvPlan()` – entscheidet Nachtladung vs. PV-Überschuss am Tag. Bei **PV-Gesamtprognose < 12 kWh** und ausreichenden Nachtstunden werden die billigsten Nachtfenster für `hoursNeeded = EV_TARGET_KWH / EV_CHARGE_POWER_KW` gewählt. Ergebnis:
  
```json
{
  "value": 12,
  "time": "2025-08-16T06:00:00.000Z",
  "hours": 4
}
```

- `buildHpPlan()` – wählt je **2 Stunden** für **Warmwasser (DHW)** und **Heizen** aus den günstigsten Stunden.

### 3.5 Anwenden der Pläne

- `applyEvPlan()` – schreibt EV-Plan als JSON nach `evcc.0.loadpoints.1.plan.energy`. Umschalten des EV-Lademodus (`evcc.0.loadpoints.1.mode/set`) ist **noch offen**.  
- `applyHpPlan()` – formatiert Zeiten/Preise für Log; bei `SET_PLANS = true` werden per `schedule()` **DHW-Soll +5 °C** für ~90 Min. und **Heiz-Flow +3 °C** für ~2 h gesetzt und anschließend zurückgenommen (Register-Adressen/Werte **validieren**).

### 3.6 Zusammenfassung und Speicherung

- `buildSummaryText()` – kompakte Statuszeile mit PV-Gesamtprognose, Min/Max-Preis, EV-Planstatus und billigsten Nachtstunden.  
- `storeGrafanaData()` – erzeugt **Long-Tabelle** (Preis/Forecast/Nachtflag je Stunde) in `tableJsonLong` und stündliche Einzelstates (z. B. `prices_ct.hourHH`, `forecastWh.hourHH`).

**Beispiel `tableJsonLong`:**

```json
[
  {"time":"16.08.2025, 02:00:00","field":"price_ct_kwh","value":8.5,"hour":"02:00:00"},
  {"time":"16.08.2025, 02:00:00","field":"forecast_kwh","value":0.6,"hour":"02:00:00"},
  {"time":"16.08.2025, 02:00:00","field":"isCheapNight","value":1,"hour":"02:00:00"}
]
```

### 3.7 Scheduler

Skript-eigener Cron-Planer in ioBroker:

```js
// Alle 60 Minuten, jeweils 10 Minuten nach voller Stunde
schedule('10 * * * *', plan24h);

// Beim Start einmalig ausführen
plan24h();
```

Bei jedem Lauf wird mit Zeitstempel geloggt (z. B. „🕒 Scheduler ausgelöst – 15.08.2025 14:10“).

---

## 4 Grafana – Visualisierung

Zwei zentrale Panels:

1. **Day-Ahead-Planung (Tabelle)**  
   - Quelle: `tableJsonLong` (SimpleAPI)  
   - Spalten: **Preis (ct/kWh)**, **PV-Forecast (kWh)**, **Nachtstunde (Ja/Nein)**  
   - Nutzen: schneller Überblick über günstige Stunden + erwartete PV-Erzeugung.

2. **Logs (Textliste)**  
   - Quelle: `detailsText` / `lines.lineXX`  
   - Beispielhafte Meldungen:

```text
🕒 Scheduler ausgelöst - 15.08.2025 14:10
💤 Billigste Nachtstunden: 16.8.2025, 03:00:00 → 8.5 ct/kWh | 16.8.2025, 04:00:00 → 8.4 ct/kWh
☀️ PV-Forecast: 15 Sonnenstunden gemappt.
📊 PV-Gesamtprognose: 6.77 kWh (Schwelle: 12.0 kWh)
💰 Günstige Nachtstunden (<0.16 €/kWh): 8 Stück
🔋 Nachtladung geplant: 12 kWh von 16.08.2025, 02:00 bis 16.08.2025, 06:00 (4 Stunden)
🔥 Wärmepumpe Warmwasser (2h): 16.08. 12:00 (0.0 ct/kWh), 16.08. 13:00 (-0.0 ct/kWh).
🔥 Wärmepumpe Heizen (2h): 16.08. 12:00 (0.0 ct/kWh), 16.08. 13:00 (-0.0 ct/kWh).
```

---

## 5 Offene To-Dos & Wartungshinweise

- [ ] **SET_PLANS aktivieren** (`true`) für produktiven Betrieb (derzeit `false`).  
- [ ] **EV-Lademodus finalisieren**: Umschaltung `evcc.0.loadpoints.1.mode/set` im Nachtplan (z. B. **FAST** während günstiger Stunden, danach **PV**). Siehe evcc-Modi (PV, Min+PV, Fast, Off).  
- [ ] **Wärmepumpen-Register prüfen**: Adressen/Werte für **DHW-Soll** (+5 °C/90 Min) und **Heiz-Flow-Offset** (+3 °C/2 h) validieren; **schreibsparsam** handeln (EEPROM-Verschleiß).  
- [ ] **Modbus-Anbindung testen**: iDM-Gerät auf **Modbus TCP** stellen („Gebäudeleittechnik“), Float-Lesung ggf. mit **Byte-Swap (word)**.  
- [ ] **Rechte & States prüfen**: `ensureState` legt viele Benutzer-States an; Schreibrechte & Bezeichnungen vor Erstlauf kontrollieren.  
- [ ] **Zeitzonen-Suffix prüfen**: In `buildSummaryText()` ggf. „(UTC)“ → „(MEZ)“ oder entfernen (Projekt läuft in `Europe/Berlin`).  
- [ ] **Grafana-Zeitformat validieren**: Panels erwarten **HH:mm:ss**; sicherstellen, dass Ausgabe passt.  
- [ ] **PV-Forecast verfeinern**: Optional mit Wetter-Adaptern (`ioBroker.darksky`, `ioBroker.daswetter`) speisen (höhere Genauigkeit).  
- [ ] **Preisgrenze evaluieren**: `CHEAP_CUTOFF_EURKWH = 0.16` regelmäßig an Marktpreise anpassen (aWATTar aktualisiert täglich; hohe Volatilität).  
- [ ] **Langzeit-KPIs in Grafana/Influx**: Aggregationen (Ø-Preis, geladene kWh, Autarkie, Kostenersparnis) definieren.

---

## 6 Fazit

Der Energy-Distribution Planner kombiniert **dynamische Stromtarife**, **PV-Forecast** und **Batteriemanagement**, um Lade- und Heizzeiten **kostenoptimal** zu wählen. Durch offene Komponenten (ioBroker, evcc, Grafana) bleibt das System **erweiterbar** und **transparent**. Für den Produktivbetrieb sollten die offenen Punkte umgesetzt werden – insbesondere **Schreibmodus aktivieren**, **Register finalisieren** (WP & EV) und **Datenrechte** prüfen. Mit diesen Anpassungen wird das System zu einem leistungsfähigen **Home-Energy-Management**.

---

### Anhang A – Beispiel: EV-Plan in evcc schreiben

```js
// Beispiel: 12 kWh Nachtladung bis 06:00 (4 Stunden)
const evPlan = { value: 12, time: '2025-08-16T06:00:00.000Z', hours: 4 };
setState('evcc.0.loadpoints.1.plan.energy', JSON.stringify(evPlan), true);

// TODO (prod):
// setState('evcc.0.loadpoints.1.mode/set', 'fast', true);   // vor/nach dem Plan passend setzen
```

### Anhang B – Preisumrechnung €/MWh → €/kWh

```js
const eurPerKWh = marketprice_eur_per_mwh / 1000;
```

### Anhang C – ioBroker-Cron

```js
// Alle 60 Minuten, plus 10 Minuten Offset
schedule('10 * * * *', plan24h);
plan24h();
```
