import fs from 'fs';
import path from 'path';
import { describe, expect, test } from '@jest/globals';

const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

describe('Amazon search navigation', () => {
  test('opens Amazon home and submits the query through its search input', () => {
    const navigateRoute = serverSource.slice(
      serverSource.indexOf("app.post('/tabs/:tabId/navigate'"),
      serverSource.indexOf('// Snapshot')
    );

    expect(navigateRoute).toContain("const isAmazonSearch = macro === '@amazon_search';");
    expect(navigateRoute).toContain("const amazonHomeUrl = 'https://www.amazon.com/';");
    expect(navigateRoute).toContain("page.goto(amazonHomeUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS })");
    expect(navigateRoute).toContain("getByRole('button', { name: /continue shopping/i })");
    expect(navigateRoute).toContain("continueShopping.waitFor({ state: 'visible', timeout: NAVIGATE_TIMEOUT_MS })");
    expect(navigateRoute).toContain("searchInput.waitFor({ state: 'visible', timeout: NAVIGATE_TIMEOUT_MS })");
    expect(navigateRoute).toContain("if (amazonSurface === 'continue')");
    expect(navigateRoute).toContain('await continueShopping.click({ noWaitAfter: true });');
    expect(navigateRoute).toContain("locator('input#twotabsearchtextbox:visible, input[name=\"field-keywords\"]:visible, input[type=\"search\"]:visible')");
    expect(navigateRoute).toContain("await searchInput.press('Enter');");
    expect(navigateRoute).toContain('if (isAmazonSearch) return navigateAmazonSearch();');
  });
});
