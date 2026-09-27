import { describe, expect, jest, test } from '@jest/globals';
import { selectOption } from '../../lib/select-option.js';

describe('selectOption', () => {
  test('prefers the visible option label', async () => {
    const locator = { selectOption: jest.fn().mockResolvedValue(['out_of_stock']) };
    await expect(selectOption(locator, 'Out of Stock')).resolves.toEqual(['out_of_stock']);
    expect(locator.selectOption).toHaveBeenCalledWith({ label: 'Out of Stock' });
  });

  test('falls back to the HTML value', async () => {
    const locator = {
      selectOption: jest.fn()
        .mockRejectedValueOnce(new Error('label missing'))
        .mockResolvedValueOnce(['out_of_stock']),
    };
    await expect(selectOption(locator, 'out_of_stock')).resolves.toEqual(['out_of_stock']);
    expect(locator.selectOption).toHaveBeenNthCalledWith(2, { value: 'out_of_stock' });
  });
});
