const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('DB load error:', e.message);
  }
  return {
    users: [],
    menus: [],
    categories: [],
    items: [],
    orders: [],
    nextId: { users: 1, menus: 1, categories: 1, items: 1, orders: 1 }
  };
}

function save(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let store = load();

function getNextId(table) {
  const id = store.nextId[table] || 1;
  store.nextId[table] = id + 1;
  return id;
}

const db = {
  // Users
  createUser(email, passwordHash, name) {
    if (store.users.find(u => u.email === email)) {
      throw new Error('UNIQUE constraint failed: email');
    }
    const user = {
      id: getNextId('users'),
      email,
      password_hash: passwordHash,
      name,
      created_at: new Date().toISOString()
    };
    store.users.push(user);
    save(store);
    return { lastInsertRowid: user.id };
  },

  getUserByEmail(email) {
    return store.users.find(u => u.email === email) || null;
  },

  getOrderById(id) {
    return store.orders.find(o => o.id === Number(id)) || null;
  },

  getUserByEmailAndHash(email, hash) {
    return store.users.find(u => u.email === email && u.password_hash === hash) || null;
  },

  getUserById(id) {
    return store.users.find(u => u.id === Number(id)) || null;
  },

  // Menus
  createMenu({ slug, owner_id, restaurant_name, description, currency, file_path, theme_color }) {
    const menu = {
      id: getNextId('menus'),
      slug,
      owner_id: owner_id || null,
      restaurant_name: restaurant_name || 'My Restaurant',
      description: description || '',
      currency: currency || 'EUR',
      theme_color: theme_color || '#efc2ae',
      is_active: 1,
      file_path: file_path || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    store.menus.push(menu);
    save(store);
    return { lastInsertRowid: menu.id };
  },

  getMenuBySlug(slug) {
    return store.menus.find(m => m.slug === slug && m.is_active === 1) || null;
  },

  getMenuById(id) {
    return store.menus.find(m => m.id === Number(id)) || null;
  },

  getMenusByOwner(ownerId) {
    return store.menus.filter(m => m.owner_id === Number(ownerId) && m.is_active === 1);
  },

  updateMenu(id, fields) {
    const menu = store.menus.find(m => m.id === Number(id));
    if (!menu) return false;
    Object.assign(menu, fields, { updated_at: new Date().toISOString() });
    save(store);
    return true;
  },

  // Categories
  createCategory(menuId, name, sortOrder = 0) {
    const cat = {
      id: getNextId('categories'),
      menu_id: Number(menuId),
      name,
      sort_order: sortOrder
    };
    store.categories.push(cat);
    save(store);
    return { lastInsertRowid: cat.id };
  },

  getCategoriesByMenu(menuId) {
    return store.categories
      .filter(c => c.menu_id === Number(menuId))
      .sort((a, b) => a.sort_order - b.sort_order);
  },

  deleteCategory(id) {
    store.categories = store.categories.filter(c => c.id !== Number(id));
    // also clear category_id on items
    store.items.forEach(i => {
      if (i.category_id === Number(id)) i.category_id = null;
    });
    save(store);
  },

  // Items
  createItem({ menu_id, category_id, name, description, price, image_url, allergens, is_vegan, is_vegetarian, is_gluten_free, sort_order }) {
    const item = {
      id: getNextId('items'),
      menu_id: Number(menu_id),
      category_id: category_id ? Number(category_id) : null,
      name,
      description: description || '',
      price: Number(price),
      image_url: image_url || null,
      allergens: allergens || '',
      is_vegan: is_vegan ? 1 : 0,
      is_vegetarian: is_vegetarian ? 1 : 0,
      is_gluten_free: is_gluten_free ? 1 : 0,
      is_available: 1,
      sort_order: sort_order || 0,
      created_at: new Date().toISOString()
    };
    store.items.push(item);
    save(store);
    return { lastInsertRowid: item.id };
  },

  getItemsByMenu(menuId, availableOnly = true) {
    let items = store.items.filter(i => i.menu_id === Number(menuId));
    if (availableOnly) items = items.filter(i => i.is_available === 1);
    return items.sort((a, b) => a.sort_order - b.sort_order);
  },

  getItemById(id) {
    return store.items.find(i => i.id === Number(id)) || null;
  },

  updateItem(id, fields) {
    const item = store.items.find(i => i.id === Number(id));
    if (!item) return false;
    const allowed = ['name', 'description', 'price', 'image_url', 'allergens', 'is_vegan', 'is_vegetarian', 'is_gluten_free', 'is_available', 'category_id', 'sort_order'];
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        if (['is_vegan', 'is_vegetarian', 'is_gluten_free', 'is_available'].includes(k)) {
          item[k] = fields[k] ? 1 : 0;
        } else if (k === 'price') {
          item[k] = Number(fields[k]);
        } else {
          item[k] = fields[k];
        }
      }
    }
    save(store);
    return true;
  },

  deleteItem(id) {
    store.items = store.items.filter(i => i.id !== Number(id));
    save(store);
  },

  countItems(menuId) {
    return store.items.filter(i => i.menu_id === Number(menuId)).length;
  },

  maxSortOrder(table, menuId) {
    const list = table === 'items'
      ? store.items.filter(i => i.menu_id === Number(menuId))
      : store.categories.filter(c => c.menu_id === Number(menuId));
    if (list.length === 0) return 0;
    return Math.max(...list.map(x => x.sort_order || 0));
  },

  // Orders
  createOrder({ menu_id, order_number, table_number, customer_name, customer_note, items, total, currency, order_type }) {
    const order = {
      id: getNextId('orders'),
      menu_id: Number(menu_id),
      order_number,
      table_number: table_number || '',
      customer_name: customer_name || 'Guest',
      customer_note: customer_note || '',
      items: typeof items === 'string' ? items : JSON.stringify(items),
      total: Number(total),
      currency: currency || 'EUR',
      status: 'new',
      order_type: order_type || 'dine-in',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    store.orders.push(order);
    save(store);
    return { lastInsertRowid: order.id };
  },

  getOrdersByMenu(menuId, limit = 50) {
    return store.orders
      .filter(o => o.menu_id === Number(menuId))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit)
      .map(o => ({
        ...o,
        items: typeof o.items === 'string' ? JSON.parse(o.items) : o.items
      }));
  },

  updateOrderStatus(orderId, status) {
    const order = store.orders.find(o => o.id === Number(orderId));
    if (!order) return false;
    order.status = status;
    order.updated_at = new Date().toISOString();
    save(store);
    return true;
  },

  getOrderStats(menuId) {
    const orders = store.orders.filter(o => o.menu_id === Number(menuId));
    const today = new Date().toISOString().slice(0, 10);
    const todayOrders = orders.filter(o => o.created_at.startsWith(today));
    return {
      totalOrders: orders.length,
      todayOrders: todayOrders.length,
      todayRevenue: todayOrders.reduce((s, o) => s + (o.total || 0), 0),
      newOrders: orders.filter(o => o.status === 'new').length,
      preparing: orders.filter(o => o.status === 'preparing').length,
      ready: orders.filter(o => o.status === 'ready').length
    };
  },

  // Sessions (simple in-memory + file)
  sessions: {},

  createSession(userId) {
    const token = require('crypto').randomBytes(32).toString('hex');
    this.sessions[token] = { userId: Number(userId), created: Date.now() };
    return token;
  },

  getSession(token) {
    if (!token || !this.sessions[token]) return null;
    // expire after 7 days
    if (Date.now() - this.sessions[token].created > 7 * 24 * 60 * 60 * 1000) {
      delete this.sessions[token];
      return null;
    }
    return this.sessions[token];
  },

  destroySession(token) {
    delete this.sessions[token];
  }
};

module.exports = db;
