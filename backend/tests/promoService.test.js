jest.mock('../models/PromoCode', () => ({
  findOneAndUpdate: jest.fn()
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));

const PromoCode = require('../models/PromoCode');
const { markPromoAsUsed } = require('../services/promoService');

describe('markPromoAsUsed - idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('applies the discount/usage increment when the order has not used this promo before', async () => {
    PromoCode.findOneAndUpdate.mockResolvedValue({ code: 'SAVE20', currentUses: 1 });

    const result = await markPromoAsUsed('SAVE20', 'user1', 'Rajesh', '919000000001', 500, 100, 400, 'order1');

    expect(result).toEqual({ success: true });
    expect(PromoCode.findOneAndUpdate).toHaveBeenCalledWith(
      { code: 'SAVE20', 'usedBy.orderId': { $ne: 'order1' } },
      expect.objectContaining({
        $inc: { currentUses: 1 },
        $push: expect.any(Object)
      }),
      { new: true }
    );
  });

  test('a retried call for the same order matches nothing and is reported as alreadyUsed without a second increment', async () => {
    // Mongo returns null when the filter (including the usedBy.orderId exclusion) matches no document -
    // i.e. this exact order already has a usedBy entry.
    PromoCode.findOneAndUpdate.mockResolvedValue(null);

    const result = await markPromoAsUsed('SAVE20', 'user1', 'Rajesh', '919000000001', 500, 100, 400, 'order1');

    expect(result).toEqual({ success: true, alreadyUsed: true });
    // Still only ever issued as a single atomic conditional update - no separate read+write race
    expect(PromoCode.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
