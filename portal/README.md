# MCDR Settlement Web Portal

A single-page web application (SPA) for the MCDR Settlement API and Keycloak authentication service.

## Tech Stack
- **Structure & Markup**: HTML5 SPA (`index.html`)
- **Styling**: Tailwind Play CDN + Glassmorphism Custom Theme (`styles.css`)
- **Logic**: Vanilla ES6 Modular Architecture (`app.js`)

## Prerequisites
 Ensure the backend services are running via Docker Compose / NestJS:
- **API Backend**: `http://localhost:3000`
- **Keycloak Auth**: `http://localhost:8081` (Realm: `mcdr`, Client: `mcdr-owner-portal`)

## How to Run
Due to Keycloak CORS configuration (`webOrigins` pinned to `http://localhost:5173`), this portal MUST be served on port `5173`.

Run using `npx serve` from the repository root:
```bash
npx serve -l 5173 portal
```

Or using Python:
```bash
python -m http.server 5173 --directory portal
```

Then open `http://localhost:5173` in your browser.

## Demo Accounts (Password: `test123`)
- **Owner Role**: `owner1`, `owner2`
- **Backoffice Role**: `backoffice1`, `backoffice2`

You can also self-register a new Owner account directly from the Sign in / Register screen.
