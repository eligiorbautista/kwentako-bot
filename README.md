# kwentako-bot

A small Node.js utility that works with `expenses.csv` (simple expense tracking utilities / bot). This repository contains a minimal Node.js script (`index.js`) and sample data (`expenses.csv`).

## Requirements

- Node.js 14+ (LTS recommended)
- npm (or yarn/pnpm)

## Install

Open PowerShell in the project root and run:

```powershell
npm install
```

## Run

Start the app with:

```powershell
node index.js
```

If `package.json` defines a `start` script you can also run:

```powershell
npm start
```

## Files

- `index.js` — main script
- `expenses.csv` — sample CSV data

## Notes & next steps

- Add configuration (environment variables) if the bot needs tokens or API keys. Do not commit secrets — use a `.env` file and ensure it is ignored (already in `.gitignore`).
- Consider adding a `LICENSE` and tests.

If you want, I can also:

- Add a `start` script to `package.json` (if missing).
- Add a more detailed usage section after I inspect `index.js`.
