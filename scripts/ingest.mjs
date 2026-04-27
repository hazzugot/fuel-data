// Daily ingester for UK CMA-mandated fuel-price feeds.
// Pulls each retailer's public JSON, normalises shape, buckets by UK region.
// Output: data/index.json + data/<REGION>.json. No external deps (Node 20 fetch).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data");

const FEEDS = [
  ["asda",       "https://storelocator.asda.com/fuel_prices_data.json"],
  ["bp",         "https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json"],
  ["esso_tesco", "https://fuelprices.esso.co.uk/latestdata.json"],
  ["jet",        "https://jetlocal.co.uk/fuel_prices_data.json"],
  ["morrisons",  "https://www.morrisons.com/fuel-prices/fuel.json"],
  ["mfg",        "https://fuel.motorfuelgroup.com/fuel_prices_data.json"],
  ["rontec",     "https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json"],
  ["sainsburys", "https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json"],
  ["tesco",      "https://www.tesco.com/fuel_prices/fuel_prices_data.json"],
  ["applegreen", "https://applegreenstores.com/fuel-prices/data.json"],
  ["moto",       "https://moto-way.com/fuel-price/fuel_prices.json"],
  ["shell",      "https://www.shell.co.uk/fuel-prices-data.html"],
];

// UK postcode-area → coarse region bucket. Keeps per-file payloads under ~200KB.
const REGION = (pc) => {
  const a = (pc || "").toUpperCase().match(/^[A-Z]+/)?.[0] ?? "ZZ";
  if (a === "BT") return "NI";
  if (/^(AB|DD|DG|EH|FK|G|HS|IV|KA|KW|KY|ML|PA|PH|TD|ZE)$/.test(a)) return "SCO";
  if (/^(CF|LD|LL|NP|SA|SY)$/.test(a)) return "WAL";
  if (/^(BB|BD|BL|CA|CH|CW|DH|DL|FY|HD|HG|HU|HX|L|LA|LS|M|NE|OL|PR|SK|SR|TS|WA|WF|WN|YO)$/.test(a)) return "N";
  if (/^(B|CV|DE|DN|DY|HR|LE|LN|NG|NN|PE|S|ST|TF|WR|WS|WV)$/.test(a)) return "MID";
  if (/^(AL|BA|BH|BN|BR|BS|CB|CM|CO|CR|CT|DA|DT|E|EC|EN|EX|GL|GU|HA|HP|IG|IP|KT|LU|ME|MK|N|NR|NW|OX|PL|PO|RG|RH|RM|SE|SG|SL|SM|SN|SO|SP|SS|SW|TA|TN|TQ|TR|TW|UB|W|WC|WD)$/.test(a)) return "S";
  return "OTHER";
};

// Some feeds nest stations differently and quote prices in £ vs pence.
const normalise = (json, brand) => {
  const arr = Array.isArray(json) ? json : (json.stations ?? json.data ?? []);
  return arr.map((s) => {
    const lat = +(s.location?.latitude ?? s.latitude ?? s.lat);
    const lng = +(s.location?.longitude ?? s.longitude ?? s.lng ?? s.lon);
    const fuelsRaw = s.prices ?? s.fuels ?? {};
    const px = {};
    for (const [k, v] of Object.entries(fuelsRaw)) {
      const n = +v;
      if (!Number.isFinite(n) || n <= 0) continue;
      // < 10 → assume £/L, scale to pence/L.
      px[k] = n < 10 ? +(n * 100).toFixed(1) : +n.toFixed(1);
    }
    return {
      id: `${brand}:${s.site_id ?? s.id ?? s.postcode ?? `${lat},${lng}`}`,
      brand,
      name: s.brand ?? s.name ?? brand,
      address: s.address ?? "",
      pc: (s.postcode || "").toUpperCase().trim(),
      lat,
      lng,
      px,
    };
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && Object.keys(r.px).length);
};

const fetchJson = async (url) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "accept": "application/json,text/plain,*/*",
        "accept-language": "en-GB,en;q=0.9",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // some retailers serve JSON with text/html content-type; parse defensively
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
};

const main = async () => {
  const all = [];
  const stats = {};
  for (const [brand, url] of FEEDS) {
    const t0 = Date.now();
    try {
      const j = await fetchJson(url);
      const rows = normalise(j, brand);
      all.push(...rows);
      stats[brand] = { ok: true, count: rows.length, ms: Date.now() - t0 };
      console.log(`[OK]   ${brand.padEnd(12)} ${rows.length.toString().padStart(5)} stations  ${Date.now() - t0}ms`);
    } catch (e) {
      stats[brand] = { ok: false, error: e.message };
      console.error(`[FAIL] ${brand.padEnd(12)} ${e.message}`);
    }
  }

  const buckets = {};
  for (const s of all) (buckets[REGION(s.pc)] ??= []).push(s);

  mkdirSync(OUT, { recursive: true });
  const index = {
    updated: new Date().toISOString(),
    total: all.length,
    regions: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    feeds: stats,
  };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 2));
  for (const [region, rows] of Object.entries(buckets)) {
    rows.sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(`${OUT}/${region}.json`, JSON.stringify(rows));
  }
  console.log("\nINDEX", index);
};

main().catch((e) => { console.error(e); process.exit(1); });
