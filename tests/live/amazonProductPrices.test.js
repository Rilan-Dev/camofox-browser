import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';

const SKIP_LIVE_TESTS = !process.env.RUN_LIVE_TESTS;
const PRODUCT_LIMIT = 3;

function productUrls(links) {
  return [...new Set(
    links
      .map(({ url }) => url)
      .filter((url) => /^https:\/\/www\.amazon\.com\/.+\/dp\/[A-Z0-9]{10}(?:[/?]|$)/.test(url))
      .map((url) => new URL(url).origin + new URL(url).pathname.match(/^(.+\/dp\/[A-Z0-9]{10})/)?.[1]),
  )].slice(0, PRODUCT_LIMIT);
}

const PRODUCT_DETAILS = `(() => ({
  title: document.querySelector('#productTitle')?.textContent?.trim() || null,
  price: document.querySelector(
    '#corePriceDisplay_desktop_feature_div .a-offscreen, #corePrice_feature_div .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox'
  )?.textContent?.trim() || null,
}))()`;

describe('Live Amazon product prices', () => {
  let serverUrl;

  beforeAll(async () => {
    if (SKIP_LIVE_TESTS) return;
    await startServer();
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    if (SKIP_LIVE_TESTS) return;
    await stopServer();
  }, 30000);

  (SKIP_LIVE_TESTS ? test.skip : test)('opens the first three result pages and prints their prices', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab();
      await client.navigate(tabId, '@amazon_search laptop stand');
      const { links } = await client.getLinks(tabId, { limit: 200 });
      const urls = productUrls(links);
      expect(urls).toHaveLength(PRODUCT_LIMIT);

      const products = [];
      for (const url of urls) {
        const navigation = await client.navigate(tabId, url);
        expect(navigation.url).toContain('/dp/');
        const { result } = await client.evaluate(tabId, PRODUCT_DETAILS);
        expect(result.title).toBeTruthy();
        expect(result.price).toBeTruthy();
        products.push({ title: result.title, price: result.price, url: navigation.url });
      }

      console.table(products);
    } finally {
      await client.cleanup();
    }
  }, 120000);
});
