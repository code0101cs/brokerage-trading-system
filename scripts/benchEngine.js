const os = require("os");

const { createBook } = require("../src/engine/orderBook.js");
const { applyCommand, bookHash } = require("../src/engine/engine.js");
const { generate } = require("../test/engine/generator.js");

const COUNT = Number(process.argv.find((a) => /^\d+$/.test(a))) || 1000000;

// --deep never ends the session, so the book keeps growing
const DEEP = process.argv.includes("--deep");

const replay = (commands, latencies) => {
    const book = createBook("TCS");
    let events = 0;

    if (latencies) {
        for (let i = 0; i < commands.length; i++) {
            const start = process.hrtime.bigint();

            events += applyCommand(book, commands[i]).length;

            latencies[i] = Number(process.hrtime.bigint() - start);
        }
    } else {
        for (let i = 0; i < commands.length; i++) {
            events += applyCommand(book, commands[i]).length;
        }
    }

    return { book, events };
};

const run = () => {
    console.log(`generating ${COUNT} commands${DEEP ? " (deep book)" : ""}`);

    const commands = generate(42, COUNT, 30, !DEEP);

    // Warm up the JIT on a short run
    replay(commands.slice(0, 100000));

    // Pass 1: plain throughput, no timer per command
    const start = process.hrtime.bigint();
    const first = replay(commands);
    const secs = Number(process.hrtime.bigint() - start) / 1e9;

    // Pass 2: the same stream with a timer around every command
    const latencies = new Float64Array(COUNT);
    const second = replay(commands, latencies);

    latencies.sort();

    const pct = (p) => latencies[Math.min(COUNT - 1, Math.floor(COUNT * p))];

    // Both passes must end in the same book
    if (bookHash(first.book) !== bookHash(second.book)) {
        console.error("replay is not deterministic");
        process.exit(1);
    }

    const cpu = os.cpus()[0];

    console.log(`node ${process.version}, ${cpu.model.trim()}, ${os.cpus().length} threads, ${Math.round(os.totalmem() / 1073741824)} GB RAM`);
    console.log(`commands: ${COUNT}, events: ${first.events}, resting orders at the end: ${first.book.orders.size}`);
    console.log(`time: ${secs.toFixed(3)} s`);
    console.log(`throughput: ${Math.round(COUNT / secs)} commands/s`);
    console.log(`latency p50: ${pct(0.5)} ns`);
    console.log(`latency p99: ${pct(0.99)} ns`);
    console.log(`latency p99.9: ${pct(0.999)} ns`);
    console.log(`latency max: ${latencies[COUNT - 1]} ns`);
    console.log(`book hash: ${bookHash(first.book)}`);
};

run();
