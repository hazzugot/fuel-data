# fuel-data

Daily ingester for UK CMA-mandated fuel-price feeds. Output is committed to `data/` and served free via jsDelivr CDN.

## URLs (after first commit)

```
https://cdn.jsdelivr.net/gh/<user>/fuel-data@latest/data/index.json
https://cdn.jsdelivr.net/gh/<user>/fuel-data@latest/data/<REGION>.json
```

Regions: `S`, `N`, `MID`, `SCO`, `WAL`, `NI`, `OTHER`.

## Run locally

```
npm run ingest
```
