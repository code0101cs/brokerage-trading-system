# Events

Every event is a plain object. The matching engine returns a list of these for each command, and the Phase 2 tests build their expected events from the examples below.

Type strings live in `src/config/events.js` as `EVENTS`, and reason strings as `REASONS`.

## Rules

- Every event carries `type`, `seq`, `ts` and `symbol`.
- `seq` is the sequence number of the command that caused the event. One command can produce several events with the same `seq`, in the order they happened.
- `ts` comes from the command, never from a clock (the engine has no `Date.now()`).
- Inside the engine, prices are whole paise: 500.00 rupees is `50000`. Quantities are whole shares. `filledValue` is the sum of `price * quantity` over the fills, in paise. The average fill price is `filledValue / filledQuantity` and is derived, never stored.
- The exchange converts paise back to rupees before anything reaches the database (ADR 0001).

## OrderAccepted

The engine took the order. Emitted first for every order that passes its own checks.

| Field | Meaning |
|---|---|
| orderId | id of the order |
| userId | owner |
| side | `BUY` or `SELL` |
| orderType | `LIMIT` or `MARKET` |
| timeInForce | `DAY`, `IOC` or `FOK` |
| price | limit price in paise, `null` for a market order |
| quantity | original quantity |

```json
{
    "type": "OrderAccepted",
    "seq": 1,
    "ts": 1700000000000,
    "symbol": "TCS",
    "orderId": 101,
    "userId": 7,
    "side": "SELL",
    "orderType": "LIMIT",
    "timeInForce": "DAY",
    "price": 50000,
    "quantity": 100
}
```

## OrderRejected

The engine refused the order and nothing changed. `reason` is `DUPLICATE_ORDER_ID` or `INVALID_ORDER`.

| Field | Meaning |
|---|---|
| orderId | id of the order |
| userId | owner |
| reason | why it was refused |

```json
{
    "type": "OrderRejected",
    "seq": 2,
    "ts": 1700000000100,
    "symbol": "TCS",
    "orderId": 101,
    "userId": 7,
    "reason": "DUPLICATE_ORDER_ID"
}
```

## TradeExecuted

One per match. The trade price is the resting order's price.

| Field | Meaning |
|---|---|
| tradeId | `<symbol>-<seq>-<n>`, where n counts matches inside one command from 1. Unique and deterministic. |
| price | trade price in paise |
| quantity | shares traded (same on both sides, I6) |
| buyOrderId, sellOrderId | the two orders |
| buyUserId, sellUserId | their owners |
| aggressor | `BUY` or `SELL`, the side of the incoming order |

```json
{
    "type": "TradeExecuted",
    "seq": 3,
    "ts": 1700000000200,
    "symbol": "TCS",
    "tradeId": "TCS-3-1",
    "price": 50000,
    "quantity": 60,
    "buyOrderId": 102,
    "sellOrderId": 101,
    "buyUserId": 8,
    "sellUserId": 7,
    "aggressor": "BUY"
}
```

## OrderPartiallyFilled

One per fill that leaves quantity open. Emitted for both sides of a trade, resting side and incoming side, each after its own fill.

| Field | Meaning |
|---|---|
| orderId, userId | the order and its owner |
| tradeId | the trade that caused this fill |
| fillPrice | price of this fill in paise |
| fillQuantity | shares in this fill |
| filledQuantity | total filled so far |
| remainingQuantity | still open |
| filledValue | total filled value so far, paise |

```json
{
    "type": "OrderPartiallyFilled",
    "seq": 3,
    "ts": 1700000000200,
    "symbol": "TCS",
    "orderId": 101,
    "userId": 7,
    "tradeId": "TCS-3-1",
    "fillPrice": 50000,
    "fillQuantity": 60,
    "filledQuantity": 60,
    "remainingQuantity": 40,
    "filledValue": 3000000
}
```

## OrderFilled

The fill that finishes the order. Same fields as OrderPartiallyFilled, and `remainingQuantity` is always 0.

```json
{
    "type": "OrderFilled",
    "seq": 3,
    "ts": 1700000000200,
    "symbol": "TCS",
    "orderId": 102,
    "userId": 8,
    "tradeId": "TCS-3-1",
    "fillPrice": 50000,
    "fillQuantity": 60,
    "filledQuantity": 60,
    "remainingQuantity": 0,
    "filledValue": 3000000
}
```

## OrderCancelled

The order will not trade any more. It keeps the fills it already had.

| Field | Meaning |
|---|---|
| orderId, userId | the order and its owner |
| cancelledQuantity | the unfilled quantity that was cancelled |
| filledQuantity | what had filled before the cancel |
| reason | `USER_REQUEST`, `NO_LIQUIDITY`, `SELF_TRADE_PREVENTED`, `IOC_REMAINDER`, `FOK_NOT_FILLABLE`, `PROTECTION_PRICE` or `REPLACED` |

I5 for the order: `filledQuantity + cancelledQuantity` equals the original quantity once it is cancelled.

```json
{
    "type": "OrderCancelled",
    "seq": 5,
    "ts": 1700000000400,
    "symbol": "TCS",
    "orderId": 102,
    "userId": 8,
    "cancelledQuantity": 20,
    "filledQuantity": 80,
    "reason": "USER_REQUEST"
}
```

## OrderExpired

A DAY order was removed at the end of the session. Same fields as OrderCancelled but with `expiredQuantity` and no `reason`.

```json
{
    "type": "OrderExpired",
    "seq": 9,
    "ts": 1700000900000,
    "symbol": "TCS",
    "orderId": 103,
    "userId": 9,
    "expiredQuantity": 50,
    "filledQuantity": 0
}
```

## OrderReplaced

A size decrease at the same price. The order keeps its place in the queue. A price change or a size increase is not this event: it is an OrderCancelled with reason `REPLACED` followed by a fresh OrderAccepted at the back of the queue.

| Field | Meaning |
|---|---|
| orderId, userId | the order and its owner |
| oldQuantity, newQuantity | original quantity before and after |
| price | unchanged price, paise |

```json
{
    "type": "OrderReplaced",
    "seq": 6,
    "ts": 1700000000500,
    "symbol": "TCS",
    "orderId": 104,
    "userId": 7,
    "oldQuantity": 100,
    "newQuantity": 70,
    "price": 50100
}
```

## CancelRejected

A cancel or replace named an order the book does not hold (unknown id or already finished). Book state is unchanged.

| Field | Meaning |
|---|---|
| orderId | the id the command named |
| reason | `ORDER_NOT_FOUND` |

```json
{
    "type": "CancelRejected",
    "seq": 7,
    "ts": 1700000000600,
    "symbol": "TCS",
    "orderId": 999,
    "reason": "ORDER_NOT_FOUND"
}
```
