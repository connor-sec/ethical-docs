const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAGES = [
  {
    name: 'invoice',
    file: 'Ethical_Invoice.html',
    title: 'Ethical Invoice',
    number: '#invoiceNumber',
    dates: ['#invoiceDate', '#sigDate'],
    due: '#dueDate',
    draftKey: 'localInvoiceDraft',
    notesInclude: 'Thank you for your business',
  },
  {
    name: 'work order',
    file: 'Ethical_WorkOrder.html',
    title: 'Ethical Work Order',
    number: '#woNumber',
    dates: ['#woDate', '#scheduledDate', '#sigDate'],
    due: null,
    draftKey: 'ethicalWorkOrderDraft',
    notesInclude: null,
  },
];

const TINY_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function installPrintStub(page) {
  return page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = function stubPrint() {
      window.__printCalls += 1;
    };
  });
}

async function addAddresses(page, lines) {
  for (const line of lines) {
    await page.locator('#addAddressBtn').click();
    const areas = page.locator('#addressesList textarea');
    await areas.nth(await areas.count() - 1).fill(line);
  }
}

async function buildPrint(page) {
  await page.evaluate(() => downloadPDF());
}

async function frameDocNumbers(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe[data-print-frame]');
    if (!frame || !frame.contentDocument) return [];
    return Array.from(frame.contentDocument.querySelectorAll('.print-doc-number')).map((el) => el.textContent.trim());
  });
}

async function frameCell(page, selector) {
  return page.evaluate((sel) => {
    const frame = document.querySelector('iframe[data-print-frame]');
    const el = frame && frame.contentDocument.querySelector(sel);
    return el ? el.textContent.trim() : '';
  }, selector);
}

for (const doc of PAGES) {
  test.describe(doc.name + ' local dates', () => {
    test.use({ timezoneId: 'America/New_York' });

    test('evening Eastern uses the local calendar day, not UTC', async ({ page }) => {
      await page.clock.install({ time: new Date('2026-11-18T20:00:00-05:00') });
      await page.goto('/' + doc.file);

      const utcDay = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      expect(utcDay).toBe('2026-11-19');

      for (const sel of doc.dates) {
        await expect(page.locator(sel)).toHaveValue('2026-11-18');
      }
      if (doc.due) await expect(page.locator(doc.due)).toHaveValue('2026-12-18');

      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Reset' }).click();

      for (const sel of doc.dates) {
        await expect(page.locator(sel)).toHaveValue('2026-11-18');
      }
      if (doc.due) await expect(page.locator(doc.due)).toHaveValue('2026-12-18');
    });
  });

  test.describe(doc.name, () => {
    let dialogs;

    test.beforeEach(async ({ page }) => {
      dialogs = [];
      page.on('pageerror', (err) => {
        throw err;
      });
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.accept();
      });
      await installPrintStub(page);
      await page.goto('/' + doc.file);
    });

    test('quoted signature fonts keep the chosen family and size in the print document', async ({ page }) => {
      await page.locator('#pocName').fill('Alex Rivera');
      await page.locator('#sigSize').fill('42');
      await buildPrint(page);

      const segoe = await page.locator('#printContainer .print-sig-name').evaluate((el) => ({
        size: el.style.fontSize,
        family: el.style.fontFamily,
        text: el.textContent,
      }));
      expect(segoe.size).toBe('42px');
      expect(segoe.family.toLowerCase()).toContain('segoe script');
      expect(segoe.text).toContain('Alex Rivera');

      await page.emulateMedia({ media: 'print' });
      const computed = await page.locator('#printContainer .print-sig-name').evaluate((el) => ({
        size: getComputedStyle(el).fontSize,
        family: getComputedStyle(el).fontFamily,
      }));
      expect(computed.size).toBe('42px');
      expect(computed.family.toLowerCase()).toContain('segoe script');

      const frameSig = await page.evaluate(() => {
        const el = document.querySelector('iframe[data-print-frame]').contentDocument.querySelector('.print-sig-name');
        return { size: el.style.fontSize, family: el.style.fontFamily };
      });
      expect(frameSig.size).toBe('42px');
      expect(frameSig.family.toLowerCase()).toContain('segoe script');

      await page.emulateMedia({ media: 'screen' });
      await page.selectOption('#sigFont', { label: 'Brush Script' });
      await page.locator('#sigSize').fill('48');
      await buildPrint(page);
      const brush = await page.locator('#printContainer .print-sig-name').evaluate((el) => ({
        size: el.style.fontSize,
        family: el.style.fontFamily,
      }));
      expect(brush.size).toBe('48px');
      expect(brush.family.toLowerCase()).toContain('brush script');

      await page.selectOption('#sigFont', { label: 'Generic Cursive' });
      await page.locator('#sigSize').fill('28');
      await buildPrint(page);
      await expect(page.locator('#printContainer .print-sig-name')).toHaveCSS('font-size', '28px');
    });

    test('document numbers keep prefixes, leading zeros, or a suffix', async ({ page }) => {
      await page.locator(doc.number).fill('INV-1042');
      await addAddresses(page, ['100 Main', '200 Main']);
      await buildPrint(page);
      expect(await frameDocNumbers(page)).toEqual(['INV-1042', 'INV-1043']);

      await page.locator(doc.number).fill('001042');
      await buildPrint(page);
      expect(await frameDocNumbers(page)).toEqual(['001042', '001043']);

      await page.locator(doc.number).fill('DRAFT');
      await buildPrint(page);
      expect(await frameDocNumbers(page)).toEqual(['DRAFT-1', 'DRAFT-2']);

      await page.locator(doc.number).fill('999');
      await buildPrint(page);
      expect(await frameDocNumbers(page)).toEqual(['999', '1000']);

      await page.locator('#addressesList .remove-addr, #addressesList .remove-btn').first().click();
      await page.locator(doc.number).fill('INV-1042');
      await buildPrint(page);
      expect(await frameDocNumbers(page)).toEqual(['INV-1042']);
    });

    test('typed amounts match the screen and the printout', async ({ page }) => {
      await page.selectOption('#currency', 'EUR');
      await page.locator('.qty-input').fill('3');
      await page.locator('.amount-input').fill('100');

      await expect(page.locator('.rate-input')).toHaveValue('33.33');
      const shownAmount = await page.locator('.amount-input').inputValue();
      expect(Number(shownAmount)).toBe(100);

      await page.getByRole('button', { name: /Add Line Item/ }).click();
      expect(Number(await page.locator('.amount-input').first().inputValue())).toBe(100);
      await expect(page.locator('.rate-input').first()).toHaveValue('33.33');

      await page.getByRole('button', { name: /Save Draft/ }).click();
      await page.getByRole('button', { name: /Load Last Draft/ }).click();
      expect(Number(await page.locator('.amount-input').first().inputValue())).toBe(100);
      await expect(page.locator('.rate-input').first()).toHaveValue('33.33');
      if (doc.name === 'invoice') {
        await expect(page.locator('#subtotal')).toHaveText('€100.00');
        await expect(page.locator('#grandTotal')).toHaveText('€100.00');
      }

      await buildPrint(page);
      const rate = await frameCell(page, '.print-rate');
      const amount = await frameCell(page, '.print-amount');
      expect(rate).toBe('€33.33');
      expect(amount).toBe('€100.00');
      const body = await page.evaluate(() => document.querySelector('iframe[data-print-frame]').contentDocument.body.textContent);
      expect(body).not.toContain('99.99');

      await page.locator('.qty-input').first().fill('0');
      await page.locator('.amount-input').first().fill('250');
      await expect(page.locator('.amount-input').first()).toHaveValue('0.00');
      await buildPrint(page);
      expect(await frameCell(page, '.print-amount')).toContain('0.00');
      expect(await frameCell(page, '.print-qty')).toBe('0');

      await page.locator('.qty-input').first().evaluate((el) => {
        el.value = '-4';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(page.locator('.qty-input').first()).toHaveValue('0');
      await page.locator('.rate-input').first().evaluate((el) => {
        el.value = '-12';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(page.locator('.rate-input').first()).toHaveValue('0');
      await buildPrint(page);
      expect(await frameCell(page, '.print-amount')).toContain('0.00');
      expect(await frameCell(page, '.print-rate')).not.toContain('-');
    });

    test('removing a logo prints nothing and saves an empty logo', async ({ page }) => {
      await page.evaluate((src) => applyLogoSrc(src), TINY_GIF);
      await page.locator('.logo-remove').click();

      const removed = await page.evaluate(() => ({
        attr: document.getElementById('logoImg').getAttribute('src'),
        stored: currentLogoForSave(),
        hidden: document.getElementById('logoImg').classList.contains('hidden'),
      }));
      expect(removed.attr).toBeNull();
      expect(removed.stored).toBe('');
      expect(removed.hidden).toBe(true);

      await buildPrint(page);
      const logos = await page.evaluate(() => document.querySelector('iframe[data-print-frame]').contentDocument.querySelectorAll('.print-logo').length);
      expect(logos).toBe(0);

      await page.getByRole('button', { name: /Save Draft/ }).click();
      const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), doc.draftKey);
      expect(saved.logo).toBe('');
      expect(dialogs.some((message) => /Draft saved/i.test(message))).toBeTruthy();
    });

    test('loading a draft without a logo clears the logo on screen', async ({ page }) => {
      await page.evaluate((src) => applyLogoSrc(src), TINY_GIF);
      await page.selectOption('#currency', 'EUR');
      await page.evaluate((key) => {
        localStorage.setItem(key, JSON.stringify({
          invoiceNumber: '55',
          woNumber: '55',
          notes: 'loaded note',
          currency: 'GBP',
          logo: '',
          items: [{ id: 1, description: 'Cable', qty: 2, rate: 4, amount: 8, type: 'Material' }],
          addresses: [],
          checklist: [],
        }));
      }, doc.draftKey);

      await page.getByRole('button', { name: /Load Last Draft/ }).click();
      expect(await page.evaluate(() => currentLogoForSave())).toBe('');
      expect(await page.evaluate(() => document.getElementById('logoImg').getAttribute('src'))).toBeNull();
      await expect(page.locator('#currency')).toHaveValue('GBP');
      await expect(page.locator('#notes')).toHaveValue('loaded note');
      await expect(page.locator('.amount-input')).toHaveValue('8.00');

      await page.evaluate((src) => applyLogoSrc(src), TINY_GIF);
      await page.evaluate((key) => {
        const raw = JSON.parse(localStorage.getItem(key));
        raw.logo = window.location.href;
        localStorage.setItem(key, JSON.stringify(raw));
      }, doc.draftKey);
      await page.getByRole('button', { name: /Load Last Draft/ }).click();
      expect(await page.evaluate(() => currentLogoForSave())).toBe('');
    });

    test('reset restores currency, signature style, and default notes', async ({ page }) => {
      const defaultNotes = await page.locator('#notes').evaluate((el) => el.defaultValue);
      if (doc.notesInclude) expect(defaultNotes).toContain(doc.notesInclude);
      else expect(defaultNotes).toBe('');

      await page.selectOption('#currency', 'EUR');
      await page.selectOption('#sigFont', { label: 'Comic Sans' });
      await page.locator('#sigSize').fill('50');
      await page.locator('#notes').fill('temporary note');
      await page.locator('#companyName').fill('Acme');

      await page.getByRole('button', { name: 'Reset' }).click();

      await expect(page.locator('#currency')).toHaveValue('USD');
      await expect(page.locator('#sigSize')).toHaveValue('36');
      await expect(page.locator('#sigSizeLabel')).toHaveText('36px');
      const font = await page.locator('#sigFont').inputValue();
      expect(font).toContain('Segoe Script');
      expect(font).not.toContain('Comic Sans');
      await expect(page.locator('#notes')).toHaveValue(defaultNotes);
      await expect(page.locator('#companyName')).toHaveValue('');
      expect(await page.evaluate(() => currentLogoForSave())).toBe('');
    });

    test('a storage failure while saving shows an error instead of failing silently', async ({ page }) => {
      await page.locator('#companyName').fill('Acme');
      await page.evaluate(() => {
        localStorage.setItem = function () {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        };
      });
      await page.getByRole('button', { name: /Save Draft/ }).click();
      expect(dialogs.some((message) => /storage is full/i.test(message) && /logo/i.test(message))).toBeTruthy();
      const stored = await page.evaluate((key) => localStorage.getItem(key), doc.draftKey);
      expect(stored).toBeNull();
    });

    test('large logos are scaled down before they are stored', async ({ page }) => {
      const result = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1400;
        canvas.height = 1400;
        const ctx = canvas.getContext('2d');
        const pixels = ctx.createImageData(canvas.width, canvas.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data[i] = (i * 13) % 255;
          pixels.data[i + 1] = (i * 7) % 255;
          pixels.data[i + 2] = (i * 3) % 255;
          pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        const big = canvas.toDataURL('image/png');
        const small = await prepareLogoDataUrl(big);
        return { big: big.length, small: small.length, header: small.slice(0, 20) };
      });
      expect(result.big).toBeGreaterThan(900000);
      expect(result.small).toBeLessThanOrEqual(900000);
      expect(result.small).toBeLessThan(result.big);
      expect(result.header).toContain('data:image/');

      const tiny = await page.evaluate(async (src) => prepareLogoDataUrl(src), TINY_GIF);
      expect(tiny).toBe(TINY_GIF);
    });

    test('choosing a logo file shows it, and print is not cleared on a timer', async ({ page }) => {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      const file = path.join(os.tmpdir(), 'ethical-docs-tiny-' + doc.name.replace(/\s+/g, '-') + '.png');
      fs.writeFileSync(file, png);
      await page.setInputFiles('#logoInput', file);
      await expect.poll(async () => page.evaluate(() => currentLogoForSave())).toMatch(/^data:image\/png/);

      await page.locator(doc.number).fill('42');
      await buildPrint(page);
      expect(await page.evaluate(() => window.__printCalls)).toBeGreaterThan(0);
      const logos = await page.evaluate(() => document.querySelector('iframe[data-print-frame]').contentDocument.querySelectorAll('img.print-logo').length);
      expect(logos).toBe(1);

      await page.waitForTimeout(2500);
      await expect(page.locator('iframe[data-print-frame]')).toHaveCount(1);
      const stillThere = await page.evaluate(() => document.querySelector('iframe[data-print-frame]').contentDocument.body.textContent);
      expect(stillThere).toContain('42');
      expect(await page.locator('#printContainer').innerHTML()).toContain('42');

      await page.evaluate(() => {
        document.querySelector('iframe[data-print-frame]').contentWindow.dispatchEvent(new Event('afterprint'));
      });
      await expect(page.locator('iframe[data-print-frame]')).toHaveCount(0);
      await expect(page.locator('#printContainer')).toBeEmpty();
      await expect(page).toHaveTitle(doc.title);
    });
  });
}
