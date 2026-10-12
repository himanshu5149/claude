const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uuidv4 = () => crypto.randomUUID();
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads dir
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG, WEBP allowed'));
  }
});

const CURRENCIES = ['EUR','USD','GBP','INR','NPR','JPY','AUD','CAD','AED'];
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}
function requireOwner(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const menu = db.getMenuBySlug(req.params.slug || req.params.menuSlug);
  if (!menu) return res.status(404).json({ error: 'Menu not found' });
  if (menu.owner_id !== user.id) return res.status(403).json({ error: 'Not your menu' });
  req.user = user; req.menu = menu;
  next();
}

function generateSlug() {
  return uuidv4().split('-')[0];
}

function generateOrderNumber() {
  return '#' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

function getUserFromReq(req) {
  const token = req.cookies.session || req.headers['x-session-token'];
  if (!token) return null;
  const session = db.getSession(token);
  if (!session) return null;
  return db.getUserById(session.userId);
}

function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

// ============ AUTH ============

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    const hash = hashPassword(password);
    const result = db.createUser(email.toLowerCase().trim(), hash, name.trim());
    const token = db.createSession(result.lastInsertRowid);
    res.cookie('session', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ success: true, userId: result.lastInsertRowid, name: name.trim(), token });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = db.getUserByEmail(String(email).toLowerCase().trim());
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    const token = db.createSession(user.id);
    res.cookie('session', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ success: true, userId: user.id, name: user.name, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies.session;
  if (token) db.destroySession(token);
  res.clearCookie('session');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUserFromReq(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, userId: user.id, name: user.name, email: user.email });
});

// ============ MENU CREATION ============

app.post('/api/menus/create', requireAuth, upload.single('menuFile'), async (req, res) => {
  try {
    const { restaurantName, description, currency, themeColor } = req.body;
    const slug = generateSlug();
    const filePath = req.file ? `/uploads/${req.file.filename}` : null;
    const user = req.user;

    const result = db.createMenu({
      slug,
      owner_id: user ? user.id : null,
      restaurant_name: restaurantName || 'My Restaurant',
      description: description || '',
      currency: CURRENCIES.includes(currency) ? currency : 'EUR',
      file_path: filePath,
      theme_color: themeColor || '#efc2ae'
    });

    const menuId = result.lastInsertRowid;

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.pdf') {
        await parsePdfMenu(menuId, req.file.path);
      } else {
        createDefaultMenuItems(menuId);
      }
    } else {
      createDefaultMenuItems(menuId);
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const menuUrl = `${protocol}://${host}/menu/${slug}`;
    const qrDataUrl = await QRCode.toDataURL(menuUrl, { width: 400, margin: 2, color: { dark: '#33443e', light: '#fffdf8' } });

    res.json({
      success: true,
      slug,
      menuUrl,
      qrDataUrl,
      menuId,
      dashboardUrl: `/dashboard/${slug}`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

async function parsePdfMenu(menuId, filePath) {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    const text = data.text || '';
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    let categoryId = null;
    let sortOrder = 0;

    const catResult = db.createCategory(menuId, 'Menu', 0);
    categoryId = catResult.lastInsertRowid;

    for (const line of lines) {
      if (line.length < 40 && !line.match(/\d+[.,]\d{2}/) && !line.match(/^\d+$/)) {
        if (line.length > 2 && line.length < 30 && !line.match(/^\d/)) {
          const catRes = db.createCategory(menuId, line, sortOrder);
          categoryId = catRes.lastInsertRowid;
          sortOrder++;
          continue;
        }
      }

      const priceMatch = line.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|£|₹|Rs\.?|\/-)?$/);
      const euroMatch = line.match(/€\s*(\d+[.,]\d{2})/);
      const dollarMatch = line.match(/[$£₹]\s*(\d+(?:[.,]\d{1,2})?)/);
      const match = priceMatch || euroMatch || dollarMatch;

      if (match) {
        const price = parseFloat(match[1].replace(',', '.'));
        const name = line.replace(match[0], '').replace(/[.\-–—]+$/, '').trim();
        if (name.length > 1 && price > 0) {
          db.createItem({
            menu_id: menuId,
            category_id: categoryId,
            name,
            description: '',
            price,
            sort_order: sortOrder
          });
          sortOrder++;
        }
      }
    }

    if (db.countItems(menuId) === 0) {
      createDefaultMenuItems(menuId);
    }
  } catch (e) {
    console.error('PDF parse error:', e.message);
    createDefaultMenuItems(menuId);
  }
}

function createDefaultMenuItems(menuId) {
  const cat1 = db.createCategory(menuId, 'Starters', 0);
  db.createItem({ menu_id: menuId, category_id: cat1.lastInsertRowid, name: 'Garden Harvest Bowl', description: 'Avocado, greens, grains, lemon dressing', price: 13, is_vegan: 1, is_vegetarian: 1, is_gluten_free: 1, sort_order: 0 });
  db.createItem({ menu_id: menuId, category_id: cat1.lastInsertRowid, name: 'Bruschetta Trio', description: 'Tomato, mushroom, and olive tapenade', price: 9, is_vegetarian: 1, sort_order: 1 });
  db.createItem({ menu_id: menuId, category_id: cat1.lastInsertRowid, name: 'Soup of the Day', description: "Chef's daily selection with artisan bread", price: 8, sort_order: 2 });

  const cat2 = db.createCategory(menuId, 'Mains', 1);
  db.createItem({ menu_id: menuId, category_id: cat2.lastInsertRowid, name: 'Truffle Tagliatelle', description: 'Wild mushrooms, parmesan, fresh truffle', price: 16, is_vegetarian: 1, sort_order: 3 });
  db.createItem({ menu_id: menuId, category_id: cat2.lastInsertRowid, name: 'Grilled Sea Bass', description: 'Herb crust, roasted vegetables, caper sauce', price: 22, is_gluten_free: 1, sort_order: 4 });
  db.createItem({ menu_id: menuId, category_id: cat2.lastInsertRowid, name: 'Herb-Crusted Lamb', description: 'Rosemary jus, dauphinoise potatoes', price: 24, sort_order: 5 });

  const cat3 = db.createCategory(menuId, 'Desserts', 2);
  db.createItem({ menu_id: menuId, category_id: cat3.lastInsertRowid, name: 'Honey Cloud Cake', description: 'Vanilla cream, local honey, berries', price: 8, is_vegetarian: 1, sort_order: 6 });
  db.createItem({ menu_id: menuId, category_id: cat3.lastInsertRowid, name: 'Chocolate Fondant', description: 'Molten center, vanilla ice cream', price: 10, is_vegetarian: 1, sort_order: 7 });
  db.createItem({ menu_id: menuId, category_id: cat3.lastInsertRowid, name: 'Cheese Selection', description: 'Artisan cheeses, crackers, chutney', price: 12, is_vegetarian: 1, sort_order: 8 });
}

// ============ MENU VIEWING ============

app.get('/api/menus/:slug', (req, res) => {
  try {
    const menu = db.getMenuBySlug(req.params.slug);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });

    const categories = db.getCategoriesByMenu(menu.id);
    const items = db.getItemsByMenu(menu.id, true);

    res.json({ menu, categories, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/menus/:slug/full', requireOwner, (req, res) => {
  try {
    const menu = db.getMenuBySlug(req.params.slug);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });

    const categories = db.getCategoriesByMenu(menu.id);
    const items = db.getItemsByMenu(menu.id, false); // include unavailable for editor

    res.json({ menu, categories, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ ORDERS ============

app.post('/api/orders', (req, res) => {
  try {
    const { menuId, items, tableNumber, customerName, customerNote, orderType } = req.body || {};

    if (!menuId || !Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: 'No items in order' });
    }

    const menu = db.getMenuById(menuId);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });

    const clean = [];
    for (const it of items) {
      const dbItem = db.getItemById(it.id);
      const qty = Math.floor(Number(it.qty));
      if (!dbItem || dbItem.menu_id !== menu.id || !dbItem.is_available) {
        return res.status(400).json({ error: 'An item is no longer available' });
      }
      if (!(qty >= 1 && qty <= 99)) return res.status(400).json({ error: 'Invalid quantity' });
      clean.push({ id: dbItem.id, name: dbItem.name, price: dbItem.price, qty });
    }
    const total = clean.reduce((s, i) => s + i.price * i.qty, 0);

    const orderNumber = generateOrderNumber();
    const result = db.createOrder({
      menu_id: menuId,
      order_number: orderNumber,
      table_number: String(tableNumber || '').slice(0, 10),
      customer_name: String(customerName || 'Guest').slice(0, 60),
      customer_note: String(customerNote || '').slice(0, 300),
      items: clean,
      total,
      currency: menu.currency,
      order_type: orderType === 'takeaway' ? 'takeaway' : 'dine-in'
    });

    res.json({
      success: true,
      orderId: result.lastInsertRowid,
      orderNumber,
      estimatedTime: '15-25 min'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:menuSlug', requireOwner, (req, res) => {
  try {
    const menu = db.getMenuBySlug(req.params.menuSlug);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });

    const orders = db.getOrdersByMenu(menu.id);
    const stats = db.getOrderStats(menu.id);
    res.json({ orders, menu, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/orders/:orderId/status', requireAuth, (req, res) => {
  try {
    const ord = db.getOrderById(req.params.orderId);
    const om = ord && db.getMenuById(ord.menu_id);
    if (!om || om.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your order' });
    const { status } = req.body;
    const valid = ['new', 'preparing', 'ready', 'completed', 'cancelled'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const ok = db.updateOrderStatus(req.params.orderId, status);
    if (!ok) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ MENU MANAGEMENT ============

app.post('/api/menus/:slug/items', requireOwner, (req, res) => {
  try {
    const menu = db.getMenuBySlug(req.params.slug);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });

    const { name, description, price, categoryId, is_vegan, is_vegetarian, is_gluten_free, allergens } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const maxSort = db.maxSortOrder('items', menu.id);
    const result = db.createItem({
      menu_id: menu.id,
      category_id: categoryId || null,
      name,
      description: description || '',
      price: Number(price),
      is_vegan: !!is_vegan,
      is_vegetarian: !!is_vegetarian,
      is_gluten_free: !!is_gluten_free,
      allergens: allergens || '',
      sort_order: maxSort + 1
    });

    res.json({ success: true, itemId: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/menus/:slug/items/:itemId', requireOwner, (req, res) => {
  try {
    const it = db.getItemById(req.params.itemId);
    if (!it || it.menu_id !== req.menu.id) return res.status(404).json({ error: 'Item not found' });
    db.deleteItem(req.params.itemId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/menus/:slug/items/:itemId', requireOwner, (req, res) => {
  try {
    const it = db.getItemById(req.params.itemId);
    if (!it || it.menu_id !== req.menu.id) return res.status(404).json({ error: 'Item not found' });
    const ok = db.updateItem(req.params.itemId, req.body);
    if (!ok) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menus/:slug/categories', requireOwner, (req, res) => {
  try {
    const menu = db.getMenuBySlug(req.params.slug);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });

    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const maxSort = db.maxSortOrder('categories', menu.id);
    const result = db.createCategory(menu.id, name, maxSort + 1);
    res.json({ success: true, categoryId: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/menus/:slug/categories/:catId', requireOwner, (req, res) => {
  try {
    db.deleteCategory(req.params.catId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/menus/:slug', requireOwner, (req, res) => {
  try {
    const menu = db.getMenuBySlug(req.params.slug);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });

    const allowed = ['restaurant_name', 'description', 'currency', 'theme_color'];
    const fields = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) fields[k] = req.body[k];
    }
    if (fields.currency && !CURRENCIES.includes(fields.currency)) return res.status(400).json({ error: 'Unsupported currency' });
    db.updateMenu(menu.id, fields);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QR Code
app.get('/api/menus/:slug/qr', async (req, res) => {
  try {
    const table = req.query.table || '';
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const menuUrl = `${protocol}://${host}/menu/${req.params.slug}${table ? '?table=' + encodeURIComponent(table) : ''}`;
    const qrImage = await QRCode.toBuffer(menuUrl, {
      width: 400,
      margin: 2,
      color: { dark: '#33443e', light: '#ffffff' }
    });
    res.type('image/png').send(qrImage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// User's menus
app.get('/api/my-menus', requireAuth, (req, res) => {
  try {
    const menus = db.getMenusByOwner(req.user.id);
    res.json({ menus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Claim ownership of a menu (for anonymous created menus)
app.post('/api/menus/:slug/claim', requireAuth, (req, res) => {
  try {
    const menu = db.getMenuBySlug(req.params.slug);
    if (!menu) return res.status(404).json({ error: 'Menu not found' });
    if (menu.owner_id && menu.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Already owned by someone else' });
    }
    db.updateMenu(menu.id, { owner_id: req.user.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ PAGE ROUTES ============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/menu/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

app.get('/dashboard/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/create', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});

app.get('/my-menus', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'my-menus.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// API 404 + error handler: always JSON
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((err, req, res, next) => {
  if (!err) return next();
  const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.status || 400);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 20MB)' : err.message;
  if (req.path.startsWith('/api')) return res.status(code).json({ error: msg });
  res.status(code).send(msg);
});

// Fallback
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍽️  Menu app running at http://localhost:${PORT}`);
});
