const STATES = [
    "NEW",
    "PENDING_RISK",
    "REJECTED",
    "ACCEPTED",
    "WORKING",
    "PARTIALLY_FILLED",
    "FILLED",
    "PENDING_CANCEL",
    "CANCELLED",
    "EXPIRED"
];

const TRIGGERS = [
    "SUBMIT",
    "RISK_PASS",
    "RISK_FAIL",
    "ACK",
    "PARTIAL_FILL",
    "FILL",
    "CANCEL_REQUEST",
    "CANCELLED",
    "EXPIRE"
];

const TRANSITIONS = {
    NEW: {
        SUBMIT: "PENDING_RISK"
    },
    PENDING_RISK: {
        RISK_PASS: "ACCEPTED",
        RISK_FAIL: "REJECTED"
    },
    ACCEPTED: {
        ACK: "WORKING",
        PARTIAL_FILL: "PARTIALLY_FILLED",
        FILL: "FILLED",
        CANCEL_REQUEST: "PENDING_CANCEL",
        CANCELLED: "CANCELLED",
        EXPIRE: "EXPIRED"
    },
    WORKING: {
        PARTIAL_FILL: "PARTIALLY_FILLED",
        FILL: "FILLED",
        CANCEL_REQUEST: "PENDING_CANCEL",
        CANCELLED: "CANCELLED",
        EXPIRE: "EXPIRED"
    },
    PARTIALLY_FILLED: {
        PARTIAL_FILL: "PARTIALLY_FILLED",
        FILL: "FILLED",
        CANCEL_REQUEST: "PENDING_CANCEL",
        CANCELLED: "CANCELLED",
        EXPIRE: "EXPIRED"
    },
    PENDING_CANCEL: {
        PARTIAL_FILL: "PENDING_CANCEL",
        FILL: "FILLED",
        CANCELLED: "CANCELLED",
        EXPIRE: "EXPIRED"
    },
    REJECTED: {},
    FILLED: {},
    CANCELLED: {},
    EXPIRED: {}
};

const TERMINAL = ["REJECTED", "FILLED", "CANCELLED", "EXPIRED"];

// Returns the next state or throws on an illegal move
const transition = (state, event) => {
    if (!Object.hasOwn(TRANSITIONS, state)) {
        throw new Error(`Unknown state: ${state}`);
    }

    if (!TRIGGERS.includes(event)) {
        throw new Error(`Unknown event: ${event}`);
    }

    if (!Object.hasOwn(TRANSITIONS[state], event)) {
        throw new Error(`Illegal transition: ${state} + ${event}`);
    }

    return TRANSITIONS[state][event];
};

module.exports = {
    STATES,
    TRIGGERS,
    TRANSITIONS,
    TERMINAL,
    transition
};
