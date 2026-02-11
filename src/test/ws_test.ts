import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3006/ws");

ws.on("open", () => {
    console.log("Connected to WebSocket");

    // Simulate a client connecting to an existing session (if any)
    // We need an ID. But we don't know the ID?
    // User's session ID from Step 663: 58517aa1-0d62-4e28-8b66-524a5e5068c3
    const id = "58517aa1-0d62-4e28-8b66-524a5e5068c3";

    console.log(`Subscribing to session: ${id}`);
    ws.send(JSON.stringify({ type: 'subscribe', id }));

    // Also try sending START to trigger resume?
    // ws.send(JSON.stringify({ type: 'start', id }));
});

ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    console.log("Received:", msg);
});

ws.on("error", (err) => {
    console.error("WS Error:", err);
});

ws.on("close", () => {
    console.log("Disconnected");
});
