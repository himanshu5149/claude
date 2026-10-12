# Menu — Digital Menu & Ordering Platform

Full-stack digital menu app for restaurants.

## Features
- Upload PDF / image menu → auto-extract items
- Beautiful public digital menu with cart, dietary filters, search
- QR code generation (table-specific)
- Live order dashboard with status workflow (new → preparing → ready → completed)
- Menu editor (add/edit/delete items & categories)
- Theme color, restaurant branding
- Simple auth (register / login) with session cookies
- Mobile-first responsive design
- Pure JS SQLite-like JSON database (no native deps)

## Quick start

```bash
cd menu-app-release
npm install
npm start
```

Open http://localhost:3000

## Pages
- `/` — Landing
- `/create` — Create new menu
- `/menu/:slug` — Customer-facing menu + ordering
- `/dashboard/:slug` — Owner live orders + editor
- `/login` — Auth

## API
See server.js for full REST endpoints.

## Notes
- Login is required to create a menu; only the owner can edit it or see orders.
- Prices are always calculated on the server from the database.
- Currencies: EUR USD GBP INR NPR JPY AUD CAD AED (add more in `public/currency.js` and `CURRENCIES` in `server.js`).
- Image menus are not OCR'd yet: a sample menu is created for you to edit. PDFs with text are parsed.
- Data lives in `data/store.json`. Back it up, and use a persistent disk if you deploy.
- Set `NODE_ENV=production` behind HTTPS.
