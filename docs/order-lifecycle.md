# Order lifecycle

The table lives in `src/config/orderStates.js` and `transition(state, event)` is the only way an order changes state. Every handler goes through it, inserts an `order_events` row, and updates with `WHERE id = $2 AND status = $3` so a concurrent writer loses with a 409.

## Diagram

```mermaid
stateDiagram-v2
    [*] --> NEW
    NEW --> PENDING_RISK: SUBMIT
    PENDING_RISK --> ACCEPTED: RISK_PASS
    PENDING_RISK --> REJECTED: RISK_FAIL

    ACCEPTED --> WORKING: ACK
    ACCEPTED --> PARTIALLY_FILLED: PARTIAL_FILL
    ACCEPTED --> FILLED: FILL
    ACCEPTED --> PENDING_CANCEL: CANCEL_REQUEST
    ACCEPTED --> CANCELLED: CANCELLED
    ACCEPTED --> EXPIRED: EXPIRE

    WORKING --> PARTIALLY_FILLED: PARTIAL_FILL
    WORKING --> FILLED: FILL
    WORKING --> PENDING_CANCEL: CANCEL_REQUEST
    WORKING --> CANCELLED: CANCELLED
    WORKING --> EXPIRED: EXPIRE

    PARTIALLY_FILLED --> PARTIALLY_FILLED: PARTIAL_FILL
    PARTIALLY_FILLED --> FILLED: FILL
    PARTIALLY_FILLED --> PENDING_CANCEL: CANCEL_REQUEST
    PARTIALLY_FILLED --> CANCELLED: CANCELLED
    PARTIALLY_FILLED --> EXPIRED: EXPIRE

    PENDING_CANCEL --> PENDING_CANCEL: PARTIAL_FILL
    PENDING_CANCEL --> FILLED: FILL
    PENDING_CANCEL --> CANCELLED: CANCELLED
    PENDING_CANCEL --> EXPIRED: EXPIRE

    REJECTED --> [*]
    FILLED --> [*]
    CANCELLED --> [*]
    EXPIRED --> [*]
```

## States

| State | Meaning |
|---|---|
| NEW | Row created, nothing checked yet. |
| PENDING_RISK | Pre-trade risk checks are running. |
| REJECTED | A risk check failed. `reject_reason` holds the message. Terminal. |
| ACCEPTED | Risk passed and the hold is in place. Not yet acknowledged by the exchange. |
| WORKING | The exchange acknowledged it and it is resting or being matched. |
| PARTIALLY_FILLED | Some quantity has traded, the rest is still open. |
| FILLED | All quantity traded. Terminal. |
| PENDING_CANCEL | A cancel was requested and the exchange has not confirmed. Fills can still arrive. |
| CANCELLED | Removed with its unfilled part. Fills it already had stay. Terminal. |
| EXPIRED | A DAY order removed at the end of the session. Terminal. |

## Events

| Event | Sent by |
|---|---|
| SUBMIT | the order intake handler, right after the row is created |
| RISK_PASS, RISK_FAIL | the pre-trade risk checks |
| ACK | the router, when the exchange acknowledges the order |
| PARTIAL_FILL, FILL | fill handling, after a trade is booked |
| CANCEL_REQUEST | the cancel handler |
| CANCELLED | the exchange, when it confirms a cancel or cancels on its own (market order with no liquidity, IOC remainder, self-trade prevention) |
| EXPIRE | the end-of-session sweep |

## Notes

- ACCEPTED can go straight to FILLED, CANCELLED or EXPIRED. A market order or an IOC order can finish inside the same exchange call that acknowledges it, so the router never has to pass through WORKING. Task 5.3 relies on this: an accepted order ends as WORKING or terminal, never stuck in ACCEPTED.
- PENDING_CANCEL stays PENDING_CANCEL on a partial fill, and moves to FILLED if the fill completes the order. This is the cancel-versus-fill race from task 4.5: the cancel handler answers 409 "Order already filled" when it finds the order FILLED.
- There is no way back from a terminal state. `transition` throws on any event for REJECTED, FILLED, CANCELLED or EXPIRED.
- The statuses in the `orders` CHECK constraint are exactly the ten states above.
