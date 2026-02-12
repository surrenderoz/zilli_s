import { file } from "bun";

const API_URL = "http://localhost:3006";
const WS_URL = "ws://localhost:3006/ws";
const FILENAME = "data.csv";

async function run() {
    console.log("Reading data.csv...");
    const csvFile = file(FILENAME);
    const content = await csvFile.text();

    console.log(`Uploading ${FILENAME} (${content.length} bytes)...`);
    const formData = new FormData();
    formData.append("file", csvFile);

    try {
        const uploadRes = await fetch(`${API_URL}/upload`, {
            method: "POST",
            body: formData
        });

        if (!uploadRes.ok) {
            console.error("Upload failed:", await uploadRes.text());
            process.exit(1);
        }

        const uploadData = await uploadRes.json();
        console.log("Upload success:", uploadData);
        const id = uploadData.id;

        if (!id) {
            console.error("No ID returned from upload");
            process.exit(1);
        }

        console.log(`Connecting to WebSocket for ID: ${id}...`);
        const ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log("WebSocket connected. Sending start command...");
            ws.send(JSON.stringify({ type: "start", id: id, concurrency: 2 }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === "row_processed") {
                    //  console.log("Row processed:", msg.data.address, "Price:", msg.data.zillow_estimated_price);
                    process.stdout.write(".");
                } else if (msg.type === "done") {
                    console.log("\nDone! Download URLs:", msg.downloadUrl, msg.downloadUrlXlsx);
                    ws.close();
                    process.exit(0);
                } else if (msg.type === "error") {
                    console.error("WS Error:", msg.message);
                    ws.close();
                    process.exit(1);
                } else {
                    console.log("WS Message:", msg);
                }
            } catch (e) {
                console.error("Error parsing message:", event.data);
            }
        };

        ws.onerror = (e) => {
            console.error("WebSocket error:", e);
            process.exit(1);
        };

        ws.onclose = () => {
            console.log("WebSocket closed.");
        };

    } catch (e) {
        console.error("Execution error:", e);
    }
}

run();
