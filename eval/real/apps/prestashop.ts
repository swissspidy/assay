/**
 * PrestaShop 8.1 (e-commerce: the storefront as a signed-in customer, and the back
 * office as the shop admin), the stand-in for WebArena's Magento shop and admin.
 * MariaDB + the official image with its demo catalogue. The installer's language
 * pack download is redirected to packs fetched once (apps/shop/pre-install.sh); the
 * installed container is committed as an image and the database reset from a dump.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import {
  docker,
  ensureNetwork,
  mariadbJson,
  mariadbQuery,
  removeContainer,
  sh,
  waitFor,
  waitHttp,
  workDir,
} from '../lib/sh.ts';
import type { OracleResult, RealApp, RealTask } from '../lib/types.ts';

const NET = 'assay-real';
const DB = 'assay-real-ps-db';
const WEB = 'assay-real-ps';
const IMAGE = 'prestashop/prestashop:8.1.7-apache';
const SEEDED_IMAGE = 'assay-real-prestashop:seeded';
const PORT = Number(process.env.ASSAY_PRESTASHOP_PORT ?? 4330);
const BASE = `http://localhost:${PORT}`;
const ADMIN = { email: 'admin@example.com', pass: 'Assay-admin-1' };
const CUSTOMER = { id: 2, email: 'pub@prestashop.com', pass: 'Assay-shop-1' };
const VERSION = '8.1.7';

// --- container lifecycle -----------------------------------------------------

const dumpFile = () => join(workDir('prestashop'), 'pristine.sql');

async function langpacks(): Promise<string> {
  const dir = workDir('prestashop', 'langpacks');
  const tr = join(dir, 'translations', 'en-US.zip');
  if (!existsSync(tr)) {
    mkdirSync(join(dir, 'translations'), { recursive: true });
    const r = await fetch(`https://i18n.prestashop-project.org/translations/${VERSION}/en-US/en-US.zip`);
    if (!r.ok) throw new Error(`language pack download failed: ${r.status}`);
    writeFileSync(tr, Buffer.from(await r.arrayBuffer()));
  }
  const mails = join(dir, 'mails', 'en-US.zip');
  if (!existsSync(mails)) {
    // There is no mail pack for en-US; an archive with one empty file satisfies the installer.
    mkdirSync(join(dir, 'mails'), { recursive: true });
    await sh('python3', ['-c', `import zipfile; zipfile.ZipFile(${JSON.stringify(mails)}, 'w').writestr('.keep', '')`]);
  }
  return dir;
}

async function startDb(): Promise<void> {
  await ensureNetwork(NET);
  await removeContainer(WEB);
  await removeContainer(DB);
  await docker(
    'run',
    '-d',
    '--name',
    DB,
    '--network',
    NET,
    '-e',
    'MARIADB_ROOT_PASSWORD=root',
    '-e',
    'MARIADB_DATABASE=prestashop',
    'mariadb:11.4',
  );
  await waitFor('prestashop db', () => mariadbQuery(DB, 'prestashop', 'SELECT 1'));
}

const q = (sql: string) => mariadbQuery(DB, 'prestashop', sql);

/** Seed on top of the demo data: known passwords, a voucher, carriers and a clean customer cart. */
async function seed(): Promise<void> {
  const hash = (
    await sh('docker', ['exec', WEB, 'php', '-r', `echo password_hash('${CUSTOMER.pass}', PASSWORD_BCRYPT);`])
  ).stdout.trim();
  await q(`UPDATE ps_customer SET passwd = '${hash}' WHERE id_customer = ${CUSTOMER.id};`);
  // A 10% voucher for the discount task (the cart rule feature switches on with the first rule).
  await q(`
    INSERT INTO ps_cart_rule (id_customer, date_from, date_to, description, quantity, quantity_per_user, priority, partial_use, code,
      minimum_amount, minimum_amount_tax, minimum_amount_currency, minimum_amount_shipping, country_restriction, carrier_restriction,
      group_restriction, cart_rule_restriction, product_restriction, shop_restriction, free_shipping, reduction_percent, reduction_amount,
      reduction_tax, reduction_currency, reduction_product, reduction_exclude_special, gift_product, gift_product_attribute, highlight, active, date_add, date_upd)
    VALUES (0, '2026-01-01 00:00:00', '2027-12-31 23:59:59', '', 1000, 1000, 1, 1, 'AUTUMN10', 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 1, 0, 0, 0, 0, 0, 1, NOW(), NOW());
    SET @r = LAST_INSERT_ID();
    INSERT INTO ps_cart_rule_lang (id_cart_rule, id_lang, name) VALUES (@r, 1, 'Autumn 10% off');
    INSERT INTO ps_cart_rule_shop (id_cart_rule, id_shop) VALUES (@r, 1);
    UPDATE ps_configuration SET value = '1' WHERE name = 'PS_CART_RULE_FEATURE_ACTIVE';
    -- There is no mail server: "never send emails", or order status changes report an error.
    UPDATE ps_configuration SET value = '3' WHERE name = 'PS_MAIL_METHOD';
  `);
}

async function startWeb(image: string, install: boolean): Promise<void> {
  const env = [
    `DB_SERVER=${DB}`,
    'DB_USER=root',
    'DB_PASSWD=root',
    'DB_NAME=prestashop',
    `PS_INSTALL_AUTO=${install ? 1 : 0}`,
    `PS_DOMAIN=localhost:${PORT}`,
    'PS_FOLDER_ADMIN=admin-dev',
    'PS_FOLDER_INSTALL=install-dev',
    `ADMIN_MAIL=${ADMIN.email}`,
    `ADMIN_PASSWD=${ADMIN.pass}`,
    'PS_LANGUAGE=en',
    'PS_COUNTRY=US',
  ].flatMap((e) => ['-e', e]);
  const preInstall = fileURLToPath(new URL('./shop/pre-install.sh', import.meta.url));
  chmodSync(preInstall, 0o755);
  const mounts = install
    ? ['-v', `${preInstall}:/tmp/pre-install-scripts/assay.sh:ro`, '-v', `${await langpacks()}:/tmp/assay-langpacks:ro`]
    : [];
  await docker('run', '-d', '--name', WEB, '--network', NET, '-p', `${PORT}:80`, ...mounts, ...env, image);
  if (install) {
    await waitFor(
      'prestashop install',
      async () => {
        const { stdout, stderr } = await docker('logs', WEB);
        const log = stdout + stderr;
        if (/installation failed|Errors :/.test(log)) throw new Error(`install failed:\n${log.slice(-2000)}`);
        if (!log.includes('Starting web server')) throw new Error('installing');
      },
      600_000,
    );
  }
  await waitHttp(`${BASE}/`, 180_000);
}

async function restore(): Promise<void> {
  await sh('docker', ['exec', '-i', DB, 'mariadb', '-uroot', '-proot', 'prestashop'], {
    input: readFileSync(dumpFile(), 'utf8'),
  });
}

async function start(): Promise<void> {
  await startDb();
  const seeded = await docker('image', 'inspect', SEEDED_IMAGE).then(
    () => true,
    () => false,
  );
  if (!existsSync(dumpFile()) || !seeded) {
    await startWeb(IMAGE, true);
    await seed();
    const { stdout } = await sh('docker', [
      'exec',
      DB,
      'mariadb-dump',
      '-uroot',
      '-proot',
      '--skip-dump-date',
      'prestashop',
    ]);
    writeFileSync(dumpFile(), stdout);
    await docker('commit', WEB, SEEDED_IMAGE);
  } else {
    await restore();
    await startWeb(SEEDED_IMAGE, false);
  }
}

async function stop(): Promise<void> {
  await removeContainer(WEB);
  await removeContainer(DB);
}

// --- backend reads -----------------------------------------------------------

interface Line {
  product: string;
  attributes: string;
  quantity: number;
}

/** "Size - L, Color - Black" for a combination, "" for none. */
const ATTRS = (
  pa: string,
) => `COALESCE((SELECT GROUP_CONCAT(CONCAT(agl.name, ' - ', al.name) ORDER BY a.id_attribute_group SEPARATOR ', ')
  FROM ps_product_attribute_combination pac JOIN ps_attribute a USING (id_attribute)
  JOIN ps_attribute_lang al ON al.id_attribute = a.id_attribute AND al.id_lang = 1
  JOIN ps_attribute_group_lang agl ON agl.id_attribute_group = a.id_attribute_group AND agl.id_lang = 1
  WHERE pac.id_product_attribute = ${pa}), '')`;

/** The customer's open cart: the most recent cart that has not become an order. */
const OPEN_CART = `(SELECT c.id_cart FROM ps_cart c WHERE c.id_customer = ${CUSTOMER.id}
  AND NOT EXISTS (SELECT 1 FROM ps_orders o WHERE o.id_cart = c.id_cart) ORDER BY c.date_upd DESC, c.id_cart DESC LIMIT 1)`;

export async function openCart(): Promise<{ lines: Line[]; vouchers: string[] }> {
  const lines = await mariadbJson<Line[]>(
    DB,
    'prestashop',
    `SELECT JSON_ARRAYAGG(JSON_OBJECT('product', pl.name, 'attributes', ${ATTRS('cp.id_product_attribute')}, 'quantity', cp.quantity))
     FROM ps_cart_product cp JOIN ps_product_lang pl ON pl.id_product = cp.id_product AND pl.id_lang = 1
     WHERE cp.id_cart = ${OPEN_CART}`,
  );
  const vouchers = await mariadbJson<string[]>(
    DB,
    'prestashop',
    `SELECT JSON_ARRAYAGG(cr.code) FROM ps_cart_cart_rule ccr JOIN ps_cart_rule cr USING (id_cart_rule) WHERE ccr.id_cart = ${OPEN_CART}`,
  );
  return { lines: lines.toSorted((a, b) => a.product.localeCompare(b.product)), vouchers };
}

interface Order {
  reference: string;
  state: string;
  payment: string;
  carrier: string;
  address: string;
  lines: Line[];
}

export async function orders(): Promise<Order[]> {
  const rows = await mariadbJson<Omit<Order, 'lines'>[]>(
    DB,
    'prestashop',
    `SELECT JSON_ARRAYAGG(JSON_OBJECT('reference', o.reference, 'state', osl.name, 'payment', o.payment, 'carrier', ca.name, 'address', ad.alias, 'id', o.id_order))
     FROM ps_orders o JOIN ps_order_state_lang osl ON osl.id_order_state = o.current_state AND osl.id_lang = 1
     JOIN ps_carrier ca ON ca.id_carrier = o.id_carrier JOIN ps_address ad ON ad.id_address = o.id_address_delivery`,
  );
  const out: Order[] = [];
  for (const r of rows as (Omit<Order, 'lines'> & { id: number })[]) {
    const lines = await mariadbJson<Line[]>(
      DB,
      'prestashop',
      `SELECT JSON_ARRAYAGG(JSON_OBJECT('product', pl.name, 'attributes', ${ATTRS('od.product_attribute_id')}, 'quantity', od.product_quantity))
       FROM ps_order_detail od JOIN ps_product_lang pl ON pl.id_product = od.product_id AND pl.id_lang = 1 WHERE od.id_order = ${r.id}`,
    );
    const { id: _id, ...rest } = r;
    out.push({ ...rest, lines: lines.toSorted((a, b) => a.product.localeCompare(b.product)) });
  }
  return out.toSorted((a, b) => a.reference.localeCompare(b.reference));
}

const addresses = () =>
  mariadbJson<Record<string, string>[]>(
    DB,
    'prestashop',
    `SELECT JSON_ARRAYAGG(JSON_OBJECT('alias', a.alias, 'firstname', a.firstname, 'lastname', a.lastname, 'address1', a.address1,
       'address2', a.address2, 'postcode', a.postcode, 'city', a.city, 'state', COALESCE(s.name, ''), 'country', cl.name, 'phone', a.phone))
     FROM ps_address a LEFT JOIN ps_state s ON s.id_state = a.id_state JOIN ps_country_lang cl ON cl.id_country = a.id_country AND cl.id_lang = 1
     WHERE a.id_customer = ${CUSTOMER.id} AND a.deleted = 0`,
  );

const wishlist = () =>
  mariadbJson<{ list: string; product: string; quantity: number }[]>(
    DB,
    'prestashop',
    `SELECT JSON_ARRAYAGG(JSON_OBJECT('list', w.name, 'product', pl.name, 'attributes', ${ATTRS('wp.id_product_attribute')}, 'quantity', wp.quantity))
     FROM ps_wishlist w JOIN ps_wishlist_product wp USING (id_wishlist) JOIN ps_product_lang pl ON pl.id_product = wp.id_product AND pl.id_lang = 1
     WHERE w.id_customer = ${CUSTOMER.id}`,
  );

const account = async () =>
  (
    await mariadbJson<{ firstname: string; lastname: string; email: string; newsletter: number }[]>(
      DB,
      'prestashop',
      `SELECT JSON_ARRAYAGG(JSON_OBJECT('firstname', firstname, 'lastname', lastname, 'email', email, 'newsletter', newsletter))
       FROM ps_customer WHERE id_customer = ${CUSTOMER.id}`,
    )
  )[0];

const catalog = () =>
  mariadbJson<{ id: number; name: string; price: number; active: number }[]>(
    DB,
    'prestashop',
    `SELECT JSON_ARRAYAGG(JSON_OBJECT('id', p.id_product, 'name', pl.name, 'price', ROUND(ps.price, 2), 'active', ps.active))
     FROM ps_product p JOIN ps_product_shop ps ON ps.id_product = p.id_product AND ps.id_shop = 1
     JOIN ps_product_lang pl ON pl.id_product = p.id_product AND pl.id_lang = 1`,
  );

function probes(): Record<string, () => Promise<unknown>> {
  return { cart: openCart, orders, addresses, wishlist, account, catalog };
}

// --- browser -----------------------------------------------------------------

async function signIn(context: BrowserContext, user: string): Promise<void> {
  const page = await context.newPage();
  if (user === 'admin') {
    await page.goto(`${BASE}/admin-dev/index.php?controller=AdminLogin`);
    await page.locator('#email').fill(ADMIN.email);
    await page.locator('#passwd').fill(ADMIN.pass);
    await Promise.all([
      page.waitForURL(/controller=AdminDashboard|\/admin-dev\/index\.php\/(?!.*login)/),
      page.locator('#submit_login').click(),
    ]);
  } else {
    await page.goto(`${BASE}/index.php?controller=authentication`);
    await page.locator('#login-form input[name=email]').fill(CUSTOMER.email);
    await page.locator('#login-form input[name=password]').fill(CUSTOMER.pass);
    await Promise.all([
      page.waitForURL((u) => !/authentication|login/.test(u.href)),
      page.locator('#submit-login').click(),
    ]);
  }
  await page.close();
}

/** Adds a product (and combination) to the cart from its product page, as a shopper would. */
async function addToCart(page: Page, id: number, qty = 1, options: Record<string, string> = {}): Promise<void> {
  await page.goto(`${BASE}/index.php?id_product=${id}&controller=product`);
  for (const [group, value] of Object.entries(options)) {
    const select = page.locator(`select[name="group[${group}]"]`);
    if (await select.count()) {
      await select.selectOption({ label: value });
    } else {
      await page.locator(`input[name="group[${group}]"][title="${value}"]`).check({ force: true });
    }
    await page.waitForTimeout(1200);
  }
  await page.locator('#quantity_wanted').fill(String(qty));
  await page.locator('[data-button-action="add-to-cart"]').click();
  await page
    .locator('#blockcart-modal')
    .getByText(/successfully added/i)
    .waitFor();
}

const cartSetup =
  (items: [number, number][]) =>
  async (page: Page): Promise<void> => {
    for (const [id, qty] of items) await addToCart(page, id, qty);
  };

async function openCartPage(page: Page): Promise<void> {
  await page.goto(`${BASE}/index.php?controller=cart&action=show`);
}

const cartLine = (page: Page, product: string) =>
  page.locator('.cart-item').filter({ has: page.locator('.product-line-info a', { hasText: product }) });

async function setCartQty(page: Page, product: string, qty: number): Promise<void> {
  await openCartPage(page);
  const input = cartLine(page, product).locator('input.js-cart-line-product-quantity');
  await input.fill(String(qty));
  await input.press('Enter');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

async function removeLine(page: Page, product: string): Promise<void> {
  await openCartPage(page);
  await cartLine(page, product).locator('a.remove-from-cart').click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

async function checkout(page: Page, o: { address: string; carrier: string; payment: RegExp }): Promise<void> {
  await page.goto(`${BASE}/index.php?controller=order`);
  // Step 1 (personal information) is done for a signed-in customer; step 2: addresses.
  const addr = page.locator('#delivery-addresses article').filter({ hasText: o.address });
  await addr.locator('input[type=radio]').check({ force: true });
  await page.waitForTimeout(800);
  await page.locator('#checkout-addresses-step button[name=confirm-addresses]').click();
  await page.locator('#checkout-delivery-step.-current').waitFor();
  const carrier = page.locator('.delivery-option').filter({ hasText: o.carrier });
  await carrier.locator('input[type=radio]').check({ force: true });
  await page.waitForTimeout(800);
  await page.locator('#checkout-delivery-step button[name=confirmDeliveryOption]').click();
  await page.locator('#checkout-payment-step.-current').waitFor();
  await page
    .locator('.payment-option')
    .filter({ hasText: o.payment })
    .locator('input[type=radio]')
    .check({ force: true });
  await page.locator('input[name="conditions_to_approve[terms-and-conditions]"]').check({ force: true });
  await page.locator('#payment-confirmation button').click();
  await page.waitForURL(/order-confirmation/);
}

/** Opens a back-office page through its sidebar link (the links carry the admin token). */
async function adminMenu(page: Page, href: string): Promise<void> {
  await page.goto(`${BASE}/admin-dev/index.php?controller=AdminDashboard`);
  const link = await page.locator(`#nav-sidebar a[href*="${href}"]`).first().getAttribute('href');
  if (!link) throw new Error(`no sidebar link to ${href}`);
  await page.goto(new URL(link, `${BASE}/admin-dev/`).href);
}

// --- tasks -------------------------------------------------------------------

const ok = (reason: string, facts?: unknown): OracleResult => ({ success: true, reason, facts });
const no = (reason: string, facts?: unknown): OracleResult => ({ success: false, reason, facts });
/**
 * Cart or order lines as text. Without `withAttributes`, lines are summed per product: most demo
 * products have a default combination (a cushion's colour, a notebook's paper) the task does not name.
 */
const fmtLines = (ls: Line[], withAttributes = false) => {
  const qty = new Map<string, number>();
  for (const l of ls) {
    const key = withAttributes && l.attributes ? `${l.product} (${l.attributes})` : l.product;
    qty.set(key, (qty.get(key) ?? 0) + Number(l.quantity));
  }
  return [...qty]
    .map(([k, n]) => `${n}x ${k}`)
    .toSorted()
    .join('; ');
};
const cartIs = async (want: string, what: string, withAttributes = false) => {
  const c = await openCart();
  const got = fmtLines(c.lines, withAttributes);
  return got === want ? ok(what, c) : no(`cart is [${got}]`, c);
};

const digitsOf = (s: string | undefined) => (s ?? '').replace(/\D/g, '');

const TASKS: RealTask[] = [
  {
    id: 's01-add-cushions',
    instruction: 'Add two Mountain fox cushions to my cart.',
    start: '/',
    user: 'customer',
    oracleDoc: "The customer's open cart holds exactly 2x Mountain fox cushion and nothing else.",
    async reference(page) {
      await addToCart(page, 9, 2);
    },
    perturbations: [
      {
        name: 'perturbed-one-cushion',
        kind: 'partial',
        async run(page) {
          await addToCart(page, 9, 1);
        },
      },
    ],
    oracle: () => cartIs('2x Mountain fox cushion', 'two Mountain fox cushions'),
  },
  {
    id: 's02-tshirt-variant',
    instruction: 'Put a Hummingbird printed t-shirt in size L, color black, into my cart.',
    start: '/',
    user: 'customer',
    oracleDoc: 'The open cart holds exactly 1x Hummingbird printed t-shirt in the combination Size L, Color Black.',
    async reference(page) {
      await addToCart(page, 1, 1, { '1': 'L', '2': 'Black' });
    },
    perturbations: [
      {
        name: 'perturbed-white',
        kind: 'wrong-item',
        async run(page) {
          await addToCart(page, 1, 1, { '1': 'L' });
        },
      },
    ],
    oracle: () => cartIs('1x Hummingbird printed t-shirt (Size - L, Color - Black)', 't-shirt L black', true),
  },
  {
    id: 's03-remove-poster',
    instruction: 'Remove the poster from my cart, but keep everything else.',
    start: '/',
    user: 'customer',
    setup: cartSetup([
      [6, 1],
      [4, 1],
      [17, 2],
    ]),
    oracleDoc:
      'The open cart holds exactly 1x Mug The best is yet to come and 2x Brown bear notebook (the poster is gone).',
    async reference(page) {
      await removeLine(page, 'The adventure begins Framed poster');
    },
    perturbations: [
      {
        name: 'perturbed-removed-mug',
        kind: 'wrong-item',
        async run(page) {
          await removeLine(page, 'Mug The best is yet to come');
        },
      },
      {
        name: 'perturbed-poster-and-notebook',
        kind: 'over-completion',
        async run(page) {
          await removeLine(page, 'The adventure begins Framed poster');
          await setCartQty(page, 'Brown bear notebook', 1);
        },
      },
    ],
    oracle: () => cartIs('1x Mug The best is yet to come; 2x Brown bear notebook', 'poster removed, rest kept'),
  },
  {
    id: 's04-checkout',
    instruction:
      'Check out my cart: deliver it to my address called "My address" with My carrier, and pay by bank wire.',
    start: '/',
    user: 'customer',
    setup: cartSetup([
      [16, 1],
      [11, 1],
    ]),
    oracleDoc:
      'Exactly one new order exists; it holds exactly 1x Mountain fox notebook and 1x Hummingbird cushion, ships to "My address" with My carrier, and its payment is bank wire.',
    async reference(page) {
      await checkout(page, { address: 'My address', carrier: 'My carrier', payment: /bank wire/i });
    },
    perturbations: [
      {
        name: 'perturbed-check-payment',
        kind: 'wrong-item',
        async run(page) {
          await checkout(page, { address: 'My address', carrier: 'My carrier', payment: /check/i });
        },
      },
    ],
    async oracle() {
      const all = await orders();
      const fresh = all.slice(0).filter((o) => !SEEDED_REFS.has(o.reference));
      if (fresh.length !== 1) return no(`${fresh.length} new orders`, fresh);
      const o = fresh[0]!;
      const facts = o;
      if (fmtLines(o.lines) !== '1x Hummingbird cushion; 1x Mountain fox notebook')
        return no(`order lines [${fmtLines(o.lines)}]`, facts);
      if (o.address !== 'My address') return no(`delivered to ${o.address}`, facts);
      if (o.carrier !== 'My carrier') return no(`carrier ${o.carrier}`, facts);
      if (!/wire|bank transfer/i.test(o.payment)) return no(`payment ${o.payment}`, facts);
      return ok('order placed as asked', facts);
    },
  },
  {
    id: 's05-new-address',
    instruction:
      'Add a new address to my account called "Office": 500 Market Street, San Francisco, California 94105, United States, phone 415-555-0100.',
    start: '/',
    user: 'customer',
    oracleDoc:
      'A new address with alias Office (case-insensitive) exists with address1 "500 Market Street", city San Francisco, postcode 94105, state California, country United States and phone 415-555-0100 (digits compared); the seeded addresses are unchanged.',
    async reference(page) {
      await page.goto(`${BASE}/index.php?controller=address`);
      const f = page.locator('.js-address-form form');
      await f.locator('select[name=id_country]').selectOption({ label: 'United States' });
      await page.waitForTimeout(1500);
      await f.locator('input[name=alias]').fill('Office');
      await f.locator('input[name=address1]').fill('500 Market Street');
      await f.locator('input[name=city]').fill('San Francisco');
      await f.locator('select[name=id_state]').selectOption({ label: 'California' });
      await f.locator('input[name=postcode]').fill('94105');
      await f.locator('input[name=phone]').fill('415-555-0100');
      await f.locator('button[type=submit]').click();
      await page.waitForURL(/addresses|controller=addresses/);
    },
    perturbations: [
      {
        name: 'perturbed-wrong-zip',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/index.php?controller=address`);
          const f = page.locator('.js-address-form form');
          await f.locator('select[name=id_country]').selectOption({ label: 'United States' });
          await page.waitForTimeout(1500);
          await f.locator('input[name=alias]').fill('Office');
          await f.locator('input[name=address1]').fill('500 Market Street');
          await f.locator('input[name=city]').fill('San Francisco');
          await f.locator('select[name=id_state]').selectOption({ label: 'California' });
          await f.locator('input[name=postcode]').fill('94103');
          await f.locator('input[name=phone]').fill('415-555-0100');
          await f.locator('button[type=submit]').click();
          await page.waitForURL(/addresses|controller=addresses/);
        },
      },
    ],
    async oracle() {
      const all = await addresses();
      const seeded = all.filter((a) => ['Mon adresse', 'My address'].includes(a.alias!));
      const office = all.filter((a) => a.alias!.trim().toLowerCase() === 'office');
      const facts = { office, count: all.length };
      if (seeded.length !== 2) return no('a seeded address was changed or removed', facts);
      if (office.length !== 1) return no(`${office.length} addresses called Office`, facts);
      const a = office[0]!;
      if (a.address1!.trim() !== '500 Market Street') return no(`address1 ${a.address1}`, facts);
      if (a.city!.trim() !== 'San Francisco') return no(`city ${a.city}`, facts);
      if (a.postcode!.trim() !== '94105') return no(`postcode ${a.postcode}`, facts);
      if (a.state !== 'California') return no(`state ${a.state}`, facts);
      if (a.country !== 'United States') return no(`country ${a.country}`, facts);
      if (digitsOf(a.phone) !== '4155550100') return no(`phone ${a.phone}`, facts);
      return ok('address added', facts);
    },
  },
  {
    id: 's06-wishlist',
    instruction: 'Add the Brown bear notebook to my wishlist.',
    start: '/',
    user: 'customer',
    oracleDoc: "The customer's wishlists hold exactly one product, the Brown bear notebook.",
    async reference(page) {
      await page.goto(`${BASE}/index.php?id_product=17&controller=product`);
      await page.locator('.product-container .wishlist-button-add, .wishlist-button-add').first().click();
      const modal = page.locator('.wishlist-add-to .modal.show, .wishlist-modal.show').first();
      await modal.waitFor();
      await modal.locator('.wishlist-list-item, li').first().click();
      await page
        .getByText(/added to wishlist|Product added/i)
        .first()
        .waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-hummingbird-notebook',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/index.php?id_product=18&controller=product`);
          await page.locator('.wishlist-button-add').first().click();
          const modal = page.locator('.wishlist-add-to .modal.show, .wishlist-modal.show').first();
          await modal.waitFor();
          await modal.locator('.wishlist-list-item, li').first().click();
          await page
            .getByText(/added to wishlist|Product added/i)
            .first()
            .waitFor();
        },
      },
    ],
    async oracle() {
      const w = await wishlist();
      const products = w.map((x) => x.product).toSorted();
      if (products.join('|') !== 'Brown bear notebook') return no(`wishlist holds [${products.join(', ')}]`, w);
      return ok('notebook on the wishlist', w);
    },
  },
  {
    id: 's07-newsletter-off',
    instruction: 'Unsubscribe me from the newsletter.',
    start: '/',
    user: 'customer',
    oracleDoc: 'The customer record has newsletter = 0; name and email are unchanged.',
    async reference(page) {
      await page.goto(`${BASE}/index.php?controller=identity`);
      const f = page.locator('#customer-form');
      await f.locator('input[name=newsletter]').uncheck({ force: true });
      await f.locator('input[name=password]').fill(CUSTOMER.pass);
      for (const box of await f.locator('input[name=psgdpr], input[name=customer_privacy]').all())
        await box.check({ force: true });
      await f.locator('button[type=submit]').click();
      await page.getByText(/Information successfully updated/i).waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-not-saved',
        kind: 'no-op',
        async run(page) {
          await page.goto(`${BASE}/index.php?controller=identity`);
          await page.locator('#customer-form input[name=newsletter]').uncheck({ force: true });
        },
      },
    ],
    async oracle() {
      const a = await account();
      if (!a) return no('customer missing');
      if (Number(a.newsletter) !== 0) return no('still subscribed', a);
      if (a.firstname !== 'John' || a.lastname !== 'DOE' || a.email !== CUSTOMER.email)
        return no('account details changed', a);
      return ok('unsubscribed', a);
    },
  },
  {
    id: 's08-mugs-by-price',
    instruction: 'Show me the mugs in the shop, cheapest first.',
    start: '/',
    user: 'customer',
    oracleDoc:
      'The final page is the product search for "mug" (any case, singular or plural) sorted by price ascending (order=product.price.asc). Judged runs: see the label note.',
    async reference(page) {
      await page.locator('input[name=s]').first().fill('mug');
      await page.locator('input[name=s]').first().press('Enter');
      await page.waitForURL(/controller=search|\/search/);
      await page.locator('.products-sort-order .select-title').click();
      await page
        .locator('.products-sort-order .dropdown-menu a')
        .filter({ hasText: /Price, low to high/i })
        .click();
      await page.waitForURL(/order=product\.price\.asc/);
      await page.waitForLoadState('networkidle');
    },
    perturbations: [
      {
        name: 'perturbed-high-to-low',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/index.php?controller=search&s=mug&order=product.price.desc`);
        },
      },
    ],
    async oracle(_app, end) {
      const u = new URL(end.url);
      const facts = {
        path: u.pathname,
        s: u.searchParams.get('s'),
        order: u.searchParams.get('order'),
        controller: u.searchParams.get('controller'),
      };
      const search = u.pathname.endsWith('/search') || u.searchParams.get('controller') === 'search';
      if (!search) return no('not the search page', facts);
      if (!/^mugs?$/i.test((u.searchParams.get('s') ?? '').trim())) return no('search is not for mugs', facts);
      if (u.searchParams.get('order') !== 'product.price.asc') return no('not sorted by price ascending', facts);
      return ok('mugs by price', facts);
    },
  },
  {
    id: 's09-mug-quantity',
    instruction: 'Change the quantity of the mug in my cart to 3.',
    start: '/',
    user: 'customer',
    setup: cartSetup([
      [8, 1],
      [11, 1],
    ]),
    oracleDoc: 'The open cart holds exactly 3x Mug Today is a good day and 1x Hummingbird cushion.',
    async reference(page) {
      await setCartQty(page, 'Mug Today is a good day', 3);
    },
    perturbations: [
      {
        name: 'perturbed-cushion-3',
        kind: 'wrong-item',
        async run(page) {
          await setCartQty(page, 'Hummingbird cushion', 3);
        },
      },
    ],
    oracle: () => cartIs('1x Hummingbird cushion; 3x Mug Today is a good day', 'mug quantity 3'),
  },
  {
    id: 's10-voucher',
    instruction: 'Apply the discount code AUTUMN10 to my cart.',
    start: '/',
    user: 'customer',
    setup: cartSetup([[2, 1]]),
    oracleDoc: 'The open cart has the voucher AUTUMN10 applied and still holds exactly 1x Hummingbird printed sweater.',
    async reference(page) {
      await openCartPage(page);
      await page.locator('.promo-code-button a, a.promo-code-button, [href="#promo-code"]').first().click();
      await page.locator('input[name=discount_name]').fill('AUTUMN10');
      await page.locator('form[action*="cart"] button[type=submit]').filter({ hasText: /add/i }).first().click();
      await page
        .locator('.cart-summary-line')
        .filter({ hasText: /Autumn/i })
        .first()
        .waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-typo-code',
        kind: 'wrong-item',
        async run(page) {
          await openCartPage(page);
          await page.locator('.promo-code-button a, a.promo-code-button, [href="#promo-code"]').first().click();
          await page.locator('input[name=discount_name]').fill('AUTUMN01');
          await page.locator('form[action*="cart"] button[type=submit]').filter({ hasText: /add/i }).first().click();
          await page.waitForTimeout(2000);
        },
      },
    ],
    async oracle() {
      const c = await openCart();
      if (c.vouchers.join(',') !== 'AUTUMN10') return no(`vouchers [${c.vouchers.join(', ')}]`, c);
      if (fmtLines(c.lines) !== '1x Hummingbird printed sweater') return no(`cart is [${fmtLines(c.lines)}]`, c);
      return ok('voucher applied', c);
    },
  },
  {
    id: 's11-admin-price',
    instruction:
      'In the shop\'s back office, change the price of the product "Brown bear cushion" to €21.90 (tax excluded).',
    start: '/admin-dev/index.php?controller=AdminDashboard',
    user: 'admin',
    oracleDoc:
      'Product "Brown bear cushion" has a tax-excluded price of 21.90 (to the cent); every other product keeps its seeded price.',
    async reference(page) {
      await adminMenu(page, 'sell/catalog/products');
      await page
        .locator('a, td')
        .filter({ hasText: /^\s*Brown bear cushion\s*$/ })
        .first()
        .click();
      await page.waitForLoadState('load');
      const price = page
        .locator(
          '#product_pricing_retail_price_price_tax_excluded, #form_step1_price_shortcut, input[name*="price_tax_excluded"]',
        )
        .first();
      if (!(await price.isVisible())) await page.getByRole('tab', { name: /Pricing/ }).click();
      await price.fill('21.90');
      await price.press('Tab');
      await page.locator('#product_footer_save, button#submit, .product-footer button[type=submit]').first().click();
      await page
        .getByText(/Successful update|Settings updated/i)
        .first()
        .waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-other-cushion',
        kind: 'wrong-item',
        async run(page) {
          await adminMenu(page, 'sell/catalog/products');
          await page
            .locator('a, td')
            .filter({ hasText: /^\s*Mountain fox cushion\s*$/ })
            .first()
            .click();
          await page.waitForLoadState('load');
          const price = page
            .locator(
              '#product_pricing_retail_price_price_tax_excluded, #form_step1_price_shortcut, input[name*="price_tax_excluded"]',
            )
            .first();
          if (!(await price.isVisible())) await page.getByRole('tab', { name: /Pricing/ }).click();
          await price.fill('21.90');
          await price.press('Tab');
          await page
            .locator('#product_footer_save, button#submit, .product-footer button[type=submit]')
            .first()
            .click();
          await page
            .getByText(/Successful update|Settings updated/i)
            .first()
            .waitFor();
        },
      },
    ],
    async oracle() {
      const c = await catalog();
      const target = c.find((p) => p.name === 'Brown bear cushion');
      const changed = c.filter(
        (p) => p !== target && Math.abs(Number(p.price) - (SEEDED_PRICES.get(p.name) ?? Number(p.price))) > 0.004,
      );
      const facts = { target, changed };
      if (!target || Math.abs(Number(target.price) - 21.9) > 0.004) return no(`price is ${target?.price}`, facts);
      if (changed.length) return no('other prices changed', facts);
      return ok('price 21.90', facts);
    },
  },
  {
    id: 's12-admin-order-shipped',
    instruction: 'In the back office, mark order FFATNOMMJ as shipped.',
    start: '/admin-dev/index.php?controller=AdminDashboard',
    user: 'admin',
    oracleDoc: 'Order FFATNOMMJ has the current state "Shipped"; every other order keeps its seeded state.',
    async reference(page) {
      await adminMenu(page, 'sell/orders');
      await page.locator('tr').filter({ hasText: 'FFATNOMMJ' }).first().locator('td').nth(2).click();
      await page.waitForLoadState('load');
      await page.locator('#update_order_status_action_input').selectOption({ label: 'Shipped' });
      await page.locator('#update_order_status_action_btn').click();
      await page
        .getByText(/Successful update/i)
        .first()
        .waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-delivered',
        kind: 'wrong-item',
        async run(page) {
          await adminMenu(page, 'sell/orders');
          await page.locator('tr').filter({ hasText: 'FFATNOMMJ' }).first().locator('td').nth(2).click();
          await page.waitForLoadState('load');
          await page.locator('#update_order_status_action_input').selectOption({ label: 'Delivered' });
          await page.locator('#update_order_status_action_btn').click();
          await page
            .getByText(/Successful update/i)
            .first()
            .waitFor();
        },
      },
    ],
    async oracle() {
      const all = await orders();
      const target = all.find((o) => o.reference === 'FFATNOMMJ');
      const changed = all.filter(
        (o) => o !== target && SEEDED_REFS.has(o.reference) && SEEDED_REFS.get(o.reference) !== o.state,
      );
      const facts = { target: target?.state, changed: changed.map((o) => [o.reference, o.state]) };
      if (target?.state !== 'Shipped') return no(`state is ${target?.state}`, facts);
      if (changed.length) return no('other orders changed state', facts);
      return ok('shipped', facts);
    },
  },
];

/** Seeded order references and states, and product prices (demo data as installed). */
const SEEDED_REFS = new Map([
  ['XKBKNABJK', 'Canceled'],
  ['OHSATSERP', 'Awaiting check payment'],
  ['UOYEVOLI', 'Payment error'],
  ['FFATNOMMJ', 'Awaiting check payment'],
  ['KHWLILZLL', 'Awaiting bank wire payment'],
]);
const SEEDED_PRICES = new Map([
  ['Hummingbird printed t-shirt', 23.9],
  ['Hummingbird printed sweater', 35.9],
  ["The best is yet to come' Framed poster", 29],
  ['The adventure begins Framed poster', 29],
  ['Today is a good day Framed poster', 29],
  ['Mug The best is yet to come', 11.9],
  ['Mug The adventure begins', 11.9],
  ['Mug Today is a good day', 11.9],
  ['Mountain fox cushion', 18.9],
  ['Brown bear cushion', 18.9],
  ['Hummingbird cushion', 18.9],
  ['Mountain fox - Vector graphics', 9],
  ['Brown bear - Vector graphics', 9],
  ['Hummingbird - Vector graphics', 9],
  ['Pack Mug + Framed poster', 35],
  ['Mountain fox notebook', 12.9],
  ['Brown bear notebook', 12.9],
  ['Hummingbird notebook', 12.9],
  ['Customizable mug', 13.9],
]);

export const prestashop: RealApp = {
  name: 'prestashop',
  title: 'PrestaShop 8.1 (e-commerce: storefront as a customer, back office as the admin)',
  baseURL: BASE,
  start,
  reset: restore,
  stop,
  signIn,
  probes,
  tasks: TASKS,
};
