import { Elysia } from "elysia";
import { unlink, readFile, readdir, appendFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import pLimit from "p-limit";
import { ParseCsv } from "../utils/parser";
import { processAddress } from "./zen_row";
import { mkConfig, generateCsv, asString } from "export-to-csv";
import * as XLSX from 'xlsx';
import csvParser from 'csv-parser';
import redis from '../lib/redis';

// Configs
const csvConfig = mkConfig({ useKeysAsHeaders: true, filename: 'processed_data', useBom: false });
const appendConfig = mkConfig({ useKeysAsHeaders: false, filename: 'processed_data', useBom: false }); // No header for append

// Limit removed, set per-session based on message

// In-memory store (mirrors disk state)
const uploadStore = new Map<string, {
  id: string,
  rows: any[],           // Source rows
  total: number,
  originalName: string,
  processedRows: any[],  // Completed rows
  isStopped: boolean,
  isProcessing: boolean, // Track active loop
  isPaused: boolean,
  noLinkCount: number,
  resumeResolver: (() => void) | null,
  clients: any[]
}>();

// --- Persistence Helpers ---

// Load state from disk on startup
async function initUploadStore() {
  try {
    if (!existsSync('uploads')) await Bun.write('uploads/.keep', '');

    const files = await readdir('uploads');
    for (const file of files) {
      if (file.startsWith('meta_') && file.endsWith('.json')) {
        const id = file.replace('meta_', '').replace('.json', '');

        try {
          // Load Meta
          const meta = JSON.parse(await readFile(`uploads/${file}`, 'utf-8'));

          // Load Processed Rows
          const processedRows: any[] = [];
          const processedPath = `uploads/processed_${id}.csv`;
          if (existsSync(processedPath)) {
            await new Promise((resolve, reject) => {
              createReadStream(processedPath)
                .pipe(csvParser())
                .on('data', (d) => {
                  // Strip BOM and stray quotes from keys
                  const clean: any = {};
                  for (const [k, v] of Object.entries(d)) {
                    clean[k.replace(/^\uFEFF/, '').replace(/^"|"$/g, '')] = v;
                  }
                  processedRows.push(clean);
                })
                .on('end', resolve)
                .on('error', reject);
            });
          }

          // Load Source Rows (if exists)
          const sourcePath = `uploads/source_${id}.csv`;
          let rows: any[] = [];
          if (existsSync(sourcePath)) {
            rows = await ParseCsv(sourcePath);
          } else if (processedRows.length === meta.total) {
            // Completed and cleaned up
            rows = [];
          }

          // Populate Store
          uploadStore.set(id, {
            id,
            rows,
            total: meta.total,
            originalName: meta.originalName,
            processedRows,
            isStopped: false,
            isProcessing: false,
            isPaused: false,
            noLinkCount: 0,
            resumeResolver: null,
            clients: []
          });

          // Sync processed rows to Redis (ensures disk-only data appears in Results page)
          if (processedRows.length > 0) {
            const fileName = (meta.originalName || 'unknown').toLowerCase().trim();
            let batch: string[] = [];
            let totalSynced = 0;

            const flushBatch = async (items: { key: string, value: string }[]) => {
              if (items.length === 0) return;
              const p = redis.pipeline();
              const keys: string[] = [];
              for (const item of items) {
                p.set(item.key, item.value);
                keys.push(item.key);
              }
              p.sadd("result_keys", ...keys);
              await p.exec();
              totalSynced += items.length;
            };

            let batchItems: { key: string, value: string }[] = [];

            for (const row of processedRows) {
              const address = (row.address || 'unknown').toLowerCase().trim();
              const resultKey = `result:${fileName}:${address}`;

              batchItems.push({
                key: resultKey,
                value: JSON.stringify({
                  ...row,
                  file_name: meta.originalName,
                  savedAt: row.savedAt || meta.createdAt || new Date().toISOString(),
                })
              });

              if (batchItems.length >= 500) {
                await flushBatch(batchItems);
                batchItems = [];
              }
            }

            // Flush remaining
            await flushBatch(batchItems);

            console.log(`  → Synced ${totalSynced} rows to Redis for session ${id}`);
          }

          console.log(`Restored upload session: ${id} (${processedRows.length}/${meta.total})`);

        } catch (e) {
          console.error(`Failed to restore session ${id}:`, e);
        }
      }
    }
  } catch (e) {
    console.error("Init store error:", e);
  }
}

// Call init immediately
initUploadStore();

const service = new Elysia()
  // 1. Upload Endpoint
  .post("/upload", async (context) => {
    //@ts-ignore
    const { file } = context.body;
    const id = crypto.randomUUID();
    const sourcePath = `uploads/source_${id}.csv`;
    const metaPath = `uploads/meta_${id}.json`;
    const processedPath = `uploads/processed_${id}.csv`;

    try {
      // Save source file
      await Bun.write(sourcePath, file);

      // Parse source
      const parsed_Data = await ParseCsv(sourcePath);

      // Save Meta
      const meta = {
        id,
        originalName: file.name,
        total: parsed_Data.length,
        createdAt: new Date().toISOString()
      };
      await writeFile(metaPath, JSON.stringify(meta));

      // Initialize Store
      uploadStore.set(id, {
        id,
        rows: parsed_Data,
        total: parsed_Data.length,
        originalName: file.name,
        processedRows: [],
        isStopped: false,
        isProcessing: false,
        isPaused: false,
        noLinkCount: 0,
        resumeResolver: null,
        clients: []
      });

      return { id, total: parsed_Data.length, message: "File uploaded. Persistence active." };
    } catch (error) {
      console.error("Upload error:", error);
      // Cleanup
      await unlink(sourcePath).catch(() => { });
      return { error: "Failed to process upload" };
    }
  })

  // 2. WebSocket
  .ws("/ws", {
    async message(ws, message: any) {
      if (!message.id) return;

      const upload = uploadStore.get(message.id);
      if (!upload) {
        ws.send({ type: 'error', message: 'Invalid ID' });
        return;
      }

      if (!upload.clients.includes(ws)) upload.clients.push(ws);

      if (message.type === 'stop') {
        upload.isStopped = true;
        // If paused, also resolve the pause so the loop can exit
        if (upload.resumeResolver) {
          upload.resumeResolver();
          upload.resumeResolver = null;
        }
        upload.clients.forEach(c => c.send({
          type: 'stopped',
          downloadUrl: `/download/csv/${message.id}`,
          downloadUrlXlsx: `/download/xlsx/${message.id}`
        }));

        // Generate Partial XLSX
        const worksheet = XLSX.utils.json_to_sheet(upload.processedRows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Partial Data");
        const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
        const xlsxPath = `uploads/processed_${message.id}.xlsx`;
        await Bun.write(xlsxPath, xlsxBuffer);
        return;
      }

      if (message.type === 'resume') {
        if (upload.isPaused && upload.resumeResolver) {
          console.log(`Session ${message.id}: Resuming from pause...`);
          upload.isPaused = false;
          upload.noLinkCount = 0; // Reset counter so it can trigger again
          upload.resumeResolver();
          upload.resumeResolver = null;
          upload.clients.forEach(c => c.send({ type: 'resumed' }));
        }
        return;
      }

      if (message.type === 'start') {
        if (upload.isProcessing) {
          console.log(`Session ${message.id}: Already processing.`);
          return;
        }

        console.log(`Session ${message.id}: Starting/Resuming...`);
        upload.isProcessing = true;
        upload.isStopped = false; // Reset stop flag on start/resume
        upload.noLinkCount = 0; // Reset no-link counter

        try {
          // PRE-POPULATE: Check Redis for results already saved for this file's addresses
          // This prevents re-processing when the same file is uploaded again
          const existingResultKeys = await redis.smembers("result_keys");
          if (existingResultKeys.length > 0 && upload.processedRows.length === 0) {
            const fileName = (upload.originalName || '').toLowerCase().trim();
            // Build a set of addresses we need to process
            const addressSet = new Set(upload.rows.map((r: any) => r.address?.toLowerCase().trim()));

            // Check which addresses already have results for this file
            const keysToCheck = existingResultKeys.filter(k => {
              // Match keys for this file: result:{filename}:{address}
              return k.startsWith(`result:${fileName}:`);
            });

            if (keysToCheck.length > 0) {
              const checkPipeline = redis.pipeline();
              keysToCheck.forEach(k => checkPipeline.get(k));
              const existingResults = await checkPipeline.exec();

              let prePopulated = 0;
              (existingResults || []).forEach(([err, val]) => {
                if (err || !val) return;
                const parsed = JSON.parse(val as string);
                if (parsed.address && addressSet.has(parsed.address.toLowerCase().trim())) {
                  // Pre-populate as already processed
                  upload.processedRows.push({
                    client_name: parsed.client_name || '',
                    email: parsed.email || '',
                    address: parsed.address || '',
                    zillow_address: parsed.zillow_address || '',
                    zillow_estimated_price: parsed.zillow_estimated_price || '',
                    zipcode: parsed.zipcode || '',
                    property_url: parsed.property_url || '',
                    comment: parsed.comment || '',
                    file_name: upload.originalName || ''
                  });
                  prePopulated++;
                }
              });

              if (prePopulated > 0) {
                console.log(`Session ${message.id}: Pre-populated ${prePopulated} results from Redis (already processed)`);
                // Notify clients about the pre-populated progress
                upload.clients.forEach(c => c.send({
                  type: 'progress',
                  processed: upload.processedRows.length,
                  total: upload.total,
                  message: `Loaded ${prePopulated} cached results. Processing remaining...`
                }));
              }
            }
          }

          // RESUME LOGIC: Filter out already processed rows (now includes pre-populated ones)
          const processedAddresses = new Set(upload.processedRows.map(r => r.address));
          const rowsToProcess = upload.rows.filter(r => !processedAddresses.has(r.address));

          console.log(`Total: ${upload.total}, Processed: ${upload.processedRows.length}, Remaining: ${rowsToProcess.length}`);

          if (rowsToProcess.length === 0) {
            // Already done
            upload.clients.forEach(c => c.send({
              type: 'done',
              downloadUrl: `/download/csv/${message.id}`,
              downloadUrlXlsx: `/download/xlsx/${message.id}`
            }));
            return;
          }

          // Dynamic Concurrency
          const concurrency = message.concurrency || 10;
          console.log(`Processing with concurrency: ${concurrency}`);

          // --- Manual Concurrency Loop ---
          const activePromises: Promise<any>[] = [];

          for (const values of rowsToProcess) {
            // 1. Check Stop Signal (Immediate Break)
            if (upload.isStopped) {
              console.log(`Session ${message.id}: Stop signal received. Halting new requests.`);
              break;
            }

            // 2. Define Task
            const task = (async () => {
              try {
                const res = await processAddress({
                  address: values.address,
                  client_name: values.name,
                  email: values.email,
                  file_name: upload.originalName,
                });

                const processedRow = {
                  client_name: values.name,
                  email: values.email,
                  address: values.address,
                  zillow_address: res?.zillow_address || "",
                  zillow_estimated_price: res?.zillow_estimated_price || "",
                  zipcode: res?.zipcode || "",
                  property_url: res?.property_url || "",
                  comment: res?.comment || "",
                  file_name: upload.originalName || ""
                };

                // Update Memory
                upload.processedRows.push(processedRow);

                // Track no-link addresses
                if (res?.comment?.includes('No Zillow link')) {
                  upload.noLinkCount++;
                }

                // Append to Disk
                const processedPath = `uploads/processed_${message.id}.csv`;
                const isNewFile = !existsSync(processedPath);
                let csvChunk;
                if (isNewFile) {
                  csvChunk = asString(generateCsv(csvConfig)([processedRow]));
                } else {
                  const temp = asString(generateCsv(csvConfig)([processedRow]));
                  csvChunk = temp.substring(temp.indexOf('\n') + 1);
                }
                await appendFile(processedPath, csvChunk);

                // Broadcast
                const deadClients: any[] = [];
                upload.clients.forEach(c => {
                  try {
                    c.send({ type: 'row_processed', data: processedRow });
                  } catch (e) {
                    deadClients.push(c);
                  }
                });
                if (deadClients.length > 0) {
                  upload.clients = upload.clients.filter(c => !deadClients.includes(c));
                }

              } catch (e: any) {
                console.error(`Error processing ${values.address}:`, e);
                // Log failed row as processed so we don't retry forever
                const failedRow = {
                  client_name: values.name,
                  email: values.email,
                  address: values.address,
                  zillow_address: "-",
                  zillow_estimated_price: "-",
                  zipcode: "-",
                  property_url: "",
                  comment: `Processing Error: ${(e as any).message || e}`,
                  file_name: upload.originalName || ""
                };

                // Add to memory
                upload.processedRows.push(failedRow);

                // Add to disk (append)
                const processedPath = `uploads/processed_${message.id}.csv`;
                try {
                  const temp = asString(generateCsv(csvConfig)([failedRow]));
                  const csvChunk = existsSync(processedPath) ? temp.substring(temp.indexOf('\n') + 1) : temp;
                  await appendFile(processedPath, csvChunk);
                } catch (ioErr) { console.error("Failed to write error row:", ioErr); }

                // Broadcast
                upload.clients.forEach(c => c.send({ type: 'row_processed', data: failedRow }));

              } finally {
                // Self-removal logic moved to outer scope handler or simplified
              }
            })();

            // 3. Add to Active List
            // Wrap to handle self-removal
            const promise = task.then(() => {
              const index = activePromises.indexOf(promise);
              if (index > -1) activePromises.splice(index, 1);
            });

            activePromises.push(promise);

            // 4. Concurrency Control (Wait if full)
            if (activePromises.length >= concurrency) {
              await Promise.race(activePromises);
            }

            // 5. Auto-pause check: if 20+ addresses had no Zillow link
            if (upload.noLinkCount >= 20 && !upload.isPaused && !upload.isStopped) {
              upload.isPaused = true;
              console.log(`Session ${message.id}: Auto-paused — ${upload.noLinkCount} addresses had no Zillow link.`);

              // Wait for in-flight requests to finish before pausing
              await Promise.all(activePromises);

              upload.clients.forEach(c => c.send({
                type: 'paused',
                noLinkCount: upload.noLinkCount,
                processed: upload.processedRows.length,
                total: upload.total
              }));

              // Block the loop until resume or stop
              await new Promise<void>((resolve) => {
                upload.resumeResolver = resolve;
              });

              // After resume — check if we were stopped while paused
              if (upload.isStopped) break;
            }
          }

          // Wait for remaining in-flight requests
          await Promise.all(activePromises);

          // Completion Check
          if (upload.processedRows.length >= upload.total) {
            // Generate final XLSX
            const worksheet = XLSX.utils.json_to_sheet(upload.processedRows);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Data");
            const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
            const xlsxPath = `uploads/processed_${message.id}.xlsx`;
            await Bun.write(xlsxPath, xlsxBuffer);

            // CLEANUP: Remove Source File
            const sourcePath = `uploads/source_${message.id}.csv`;
            if (existsSync(sourcePath)) {
              await unlink(sourcePath);
            }

            upload.clients.forEach(c => c.send({
              type: 'done',
              downloadUrl: `/download/csv/${message.id}`,
              downloadUrlXlsx: `/download/xlsx/${message.id}`
            }));
          } else if (upload.isStopped) {
            // Partial XLSX if stopped
            const worksheet = XLSX.utils.json_to_sheet(upload.processedRows);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Partial Data");
            const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
            const xlsxPath = `uploads/processed_${message.id}.xlsx`;
            await Bun.write(xlsxPath, xlsxBuffer);
          }
        } finally {
          upload.isProcessing = false;
        }
      }

      // Simple subscribe logic impl: client added above, nothing else needed.
      if (message.type === 'subscribe') {
        // Just triggers client add
      }
    },
    close(ws) {
      uploadStore.forEach(upload => {
        const index = upload.clients.indexOf(ws);
        if (index !== -1) upload.clients.splice(index, 1);
      });
    }
  })
  // 3. Downloads
  .get("/download/csv/:id", async ({ params: { id } }) => {
    const upload = uploadStore.get(id);
    // Sort logic for download (Memory or Disk)
    let rowsToDownload = [];

    if (upload && upload.processedRows.length > 0) {
      rowsToDownload = [...upload.processedRows];
    } else {
      // Fallback to disk read if not in memory (should happen via restore)
      const path = `uploads/processed_${id}.csv`;
      if (existsSync(path)) {
        rowsToDownload = await ParseCsv(path);
      }
    }

    if (rowsToDownload.length > 0) {
      // Sort by Price Desc
      rowsToDownload.sort((a: any, b: any) => {
        const priceA = parseInt(String(a.zillow_estimated_price || '').replace(/[^0-9]/g, '') || '0');
        const priceB = parseInt(String(b.zillow_estimated_price || '').replace(/[^0-9]/g, '') || '0');
        return priceB - priceA;
      });

      const csv = asString(generateCsv(csvConfig)(rowsToDownload));
      return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="results_${id}.csv"` } });
    }

    return { error: "File not found" };
  })
  .get("/download/xlsx/:id", async ({ params: { id } }) => {
    const upload = uploadStore.get(id);
    let rowsToDownload = [];

    if (upload && upload.processedRows.length > 0) {
      rowsToDownload = [...upload.processedRows];
    } else {
      const path = `uploads/processed_${id}.csv`; // Read CSV as source for XLSX
      if (existsSync(path)) {
        rowsToDownload = await ParseCsv(path);
      }
    }

    if (rowsToDownload.length > 0) {
      // Sort
      rowsToDownload.sort((a: any, b: any) => {
        const priceA = parseInt(String(a.zillow_estimated_price || '').replace(/[^0-9]/g, '') || '0');
        const priceB = parseInt(String(b.zillow_estimated_price || '').replace(/[^0-9]/g, '') || '0');
        return priceB - priceA;
      });

      // Use ExcelJS
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Zillow Data');

      // Columns
      sheet.columns = [
        { header: 'Address', key: 'address', width: 40 },
        { header: 'Client Name', key: 'client_name', width: 20 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Zillow Address', key: 'zillow_address', width: 40 },
        { header: 'Zestimate', key: 'zillow_estimated_price', width: 15 },
        { header: 'Zipcode', key: 'zipcode', width: 10 },
        { header: 'URL', key: 'property_url', width: 50 },
        { header: 'Comment', key: 'comment', width: 30 },
        { header: 'File Name', key: 'file_name', width: 30 }
      ];

      // Style Header
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a73e8' } }; // Blue header

      // Add Rows
      rowsToDownload.forEach((row: any) => {
        const r = sheet.addRow(row);

        // Format Price
        // const priceVal = parseInt(row.zillow_estimated_price.replace(/[^0-9]/g, '') || '0');
        // r.getCell('zillow_estimated_price').value = priceVal;
        // r.getCell('zillow_estimated_price').numFmt = '"$"#,##0';

        // Format URL
        if (row.property_url && row.property_url.startsWith('http')) {
          r.getCell('property_url').value = { text: row.property_url, hyperlink: row.property_url };
          r.getCell('property_url').font = { color: { argb: 'FF0000FF' }, underline: true };
        }
      });

      const buf = await workbook.xlsx.writeBuffer();
      return new Response(buf, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="results_${id}.xlsx"` } });
    }

    return { error: "File not found or no data yet" };
  })
  .delete("/session/:id", async ({ params: { id } }) => {
    // 1. Remove from memory
    uploadStore.delete(id);

    // 2. Remove files
    const files = [
      `uploads/source_${id}.csv`,
      `uploads/meta_${id}.json`,
      `uploads/processed_${id}.csv`,
      `uploads/processed_${id}.xlsx`
    ];

    for (const f of files) {
      await unlink(f).catch(() => { });
    }

    return { success: true };
  })
  // 4. Status
  .get("/status/:id", ({ params: { id } }) => {
    const upload = uploadStore.get(id);
    if (!upload) return { error: "Not found" };
    return {
      id,
      total: upload.total,
      processed: upload.processedRows.length,
      rows: upload.processedRows,
      isStopped: upload.isStopped,
      isPaused: upload.isPaused,
      noLinkCount: upload.noLinkCount,
      isProcessing: upload.isProcessing
    };
  })
  // 5. List Sessions
  .get("/sessions", async () => {
    const sessions = [];
    const files = await readdir('uploads');

    // 1. Memory sessions
    const memoryIds = new Set(uploadStore.keys());
    for (const [id, upload] of uploadStore.entries()) {
      sessions.push({
        id,
        originalName: upload.originalName,
        total: upload.total,
        processed: upload.processedRows.length,
        createdAt: new Date().toISOString(), // Approximation if meta not read, or read meta
        isInMemory: true
      });
    }

    // 2. Disk sessions (merge with memory)
    for (const file of files) {
      if (file.startsWith('meta_') && file.endsWith('.json')) {
        const id = file.replace('meta_', '').replace('.json', '');
        if (!memoryIds.has(id)) {
          try {
            const meta = JSON.parse(await readFile(`uploads/${file}`, 'utf-8'));
            // Check processed count on disk
            let processedCount = 0;
            if (existsSync(`uploads/processed_${id}.csv`)) {
              // Quick line count or just rely on meta if we updated it (we don't update meta currently)
              // For speed, let's just say "Unknown" or count lines if needed. 
              // Actually, let's use the file size or just load it if not too big for accurate count?
              // Better: just send meta and let client fetch status if needed?
              // For now, let's try to get a count from the CSV file.
              // processedCount = (await Bun.file(`uploads/processed_${id}.csv`).text()).split('\n').length - 1; 
              // The above is expensive for large files. 
              // Let's just return meta info and maybe updated at from file stats.
            }

            sessions.push({
              id,
              originalName: meta.originalName,
              total: meta.total,
              processed: meta.total, // Assume complete if on disk and not in memory? OR just -1
              createdAt: meta.createdAt || new Date().toISOString(),
              isInMemory: false
            });
          } catch (e) { }
        }
      }
    }

    // Sort by Date Desc
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return sessions;
  })
  // 6. Usage Password Management
  .get("/api/usage/check-password", async () => {
    const pwFile = "uploads/.usage_password.json";
    if (!existsSync(pwFile)) {
      return { hasPassword: false };
    }
    return { hasPassword: true };
  })
  .post("/api/usage/set-password", async ({ body }: any) => {
    const pwFile = "uploads/.usage_password.json";
    const { password } = body as { password: string };
    if (!password || password.length < 4) {
      return { error: "Password must be at least 4 characters" };
    }
    // Hash with simple base64 encoding (not production-grade, but sufficient for local tool)
    const encoded = Buffer.from(password).toString("base64");
    await writeFile(pwFile, JSON.stringify({ hash: encoded }));
    return { success: true };
  })
  .post("/api/usage/verify", async ({ body }: any) => {
    const pwFile = "uploads/.usage_password.json";
    if (!existsSync(pwFile)) {
      return { error: "No password set" };
    }
    const { password } = body as { password: string };
    const stored = JSON.parse(await readFile(pwFile, "utf-8"));
    const encoded = Buffer.from(password).toString("base64");
    if (encoded === stored.hash) {
      return { success: true };
    }
    return { error: "Incorrect password" };
  })
  // 7. ZenRows Usage/Analytics (password required via header)
  .get("/api/usage", async ({ headers }: any) => {
    // Check password
    const pwFile = "uploads/.usage_password.json";
    if (existsSync(pwFile)) {
      const pw = headers["x-usage-password"] || "";
      const stored = JSON.parse(await readFile(pwFile, "utf-8"));
      const encoded = Buffer.from(pw).toString("base64");
      if (encoded !== stored.hash) {
        return { error: "Unauthorized", code: 401 };
      }
    }

    try {
      const axios = (await import("axios")).default;
      const apiKey = process.env.API_KEY || "";

      const res = await axios.get("https://api.zenrows.com/v1/subscriptions/self/details", {
        headers: {
          "X-API-Key": apiKey,
        }
      });

      return res.data;
    } catch (err: any) {
      console.error("ZenRows usage fetch error:", err.message);
      return { error: "Failed to fetch usage data", details: err.message };
    }
  })
  // 8. Redis-backed Results (persist after session delete)
  .get("/api/results", async ({ query }: any) => {
    try {
      const keys = await redis.smembers("result_keys");
      if (!keys || keys.length === 0) return { rows: [], total: 0 };

      const pipeline = redis.pipeline();
      keys.forEach(k => pipeline.get(k));
      const results = await pipeline.exec();

      let rows = (results || [])
        .map(([err, val]) => (err || !val) ? null : JSON.parse(val as string))
        .filter(Boolean);

      // Apply filters
      if (query.file_name) {
        rows = rows.filter((r: any) => r.file_name === query.file_name);
      }
      if (query.date) {
        const filterDate = new Date(query.date).toDateString();
        rows = rows.filter((r: any) => r.savedAt && new Date(r.savedAt).toDateString() === filterDate);
      }

      // Sort by date desc
      rows.sort((a: any, b: any) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime());

      return { rows, total: rows.length };
    } catch (err: any) {
      console.error("Redis results fetch error:", err.message);
      return { error: "Failed to fetch results", details: err.message };
    }
  })
  .get("/api/results/files", async () => {
    try {
      const keys = await redis.smembers("result_keys");
      if (!keys || keys.length === 0) return { files: [] };

      const pipeline = redis.pipeline();
      keys.forEach(k => pipeline.get(k));
      const results = await pipeline.exec();

      const fileSet = new Set<string>();
      (results || []).forEach(([err, val]) => {
        if (!err && val) {
          const parsed = JSON.parse(val as string);
          if (parsed.file_name) fileSet.add(parsed.file_name);
        }
      });

      return { files: [...fileSet].sort() };
    } catch (err: any) {
      return { error: "Failed to fetch file list", details: err.message };
    }
  })
  .get("/api/results/export/:fileName", async ({ params: { fileName } }: any) => {
    try {
      const decodedName = decodeURIComponent(fileName);
      const keys = await redis.smembers("result_keys");
      if (!keys || keys.length === 0) return { error: "No data found" };

      const pipeline = redis.pipeline();
      keys.forEach(k => pipeline.get(k));
      const results = await pipeline.exec();

      const rows = (results || [])
        .map(([err, val]) => (err || !val) ? null : JSON.parse(val as string))
        .filter((r: any) => r && r.file_name === decodedName)
        .sort((a: any, b: any) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime());

      if (rows.length === 0) {
        return { error: "No data found for this file" };
      }

      // Sort by highest Zestimate first
      rows.sort((a: any, b: any) => {
        const priceA = parseInt(String(a.zillow_estimated_price || '').replace(/[^0-9]/g, '') || '0');
        const priceB = parseInt(String(b.zillow_estimated_price || '').replace(/[^0-9]/g, '') || '0');
        return priceB - priceA;
      });

      // Use ExcelJS for styled export
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Zillow Results');

      // Define columns
      sheet.columns = [
        { header: 'Client Name', key: 'client_name', width: 22 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Address', key: 'address', width: 42 },
        { header: 'Zillow Address', key: 'zillow_address', width: 35 },
        { header: 'Zestimate', key: 'zillow_estimated_price', width: 16 },
        { header: 'Zipcode', key: 'zipcode', width: 12 },
        { header: 'URL', key: 'property_url', width: 50 },
        { header: 'Comment', key: 'comment', width: 30 },
        { header: 'Date', key: 'date', width: 22 },
      ];

      // Style header row
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a73e8' } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 28;

      // Add data rows
      rows.forEach((r: any, idx: number) => {
        const row = sheet.addRow({
          client_name: r.client_name || '',
          email: r.email || '',
          address: r.address || '',
          zillow_address: r.zillow_address || '',
          zillow_estimated_price: r.zillow_estimated_price || '',
          zipcode: r.zipcode || '',
          property_url: r.property_url || '',
          comment: r.comment || '',
          date: r.savedAt ? new Date(r.savedAt).toLocaleString() : '',
        });

        // Alternate row colors
        if (idx % 2 === 0) {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6FC' } };
        }

        // Hyperlink URLs
        if (r.property_url && r.property_url.startsWith('http')) {
          row.getCell('property_url').value = { text: r.property_url, hyperlink: r.property_url };
          row.getCell('property_url').font = { color: { argb: 'FF0000FF' }, underline: true };
        }
      });

      // Add borders to all cells
      sheet.eachRow((row: any) => {
        row.eachCell((cell: any) => {
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          };
        });
      });

      // Auto-filter on header
      sheet.autoFilter = { from: 'A1', to: `I${rows.length + 1}` };

      const buf = await workbook.xlsx.writeBuffer();
      const tmpPath = `uploads/export_${Date.now()}.xlsx`;
      await Bun.write(tmpPath, buf);
      const file = Bun.file(tmpPath);
      const response = new Response(file, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${decodedName.replace('.csv', '')}_results.xlsx"`,
        }
      });
      setTimeout(() => unlink(tmpPath).catch(() => { }), 30000);
      return response;
    } catch (err: any) {
      console.error("Export error:", err.message);
      return { error: "Failed to export", details: err.message };
    }
  })
  // 9. Cleanup/Deduplicate old Redis result keys
  .post("/api/results/cleanup", async () => {
    try {
      const keys = await redis.smembers("result_keys");
      if (!keys || keys.length === 0) return { message: "No results to clean up", before: 0, after: 0 };

      const pipeline = redis.pipeline();
      keys.forEach(k => pipeline.get(k));
      const results = await pipeline.exec();

      // Group by file_name + address, keep the newest
      const bestByKey = new Map<string, { data: any, oldKey: string }>();
      const oldKeysToRemove: string[] = [];

      (results || []).forEach(([err, val], idx) => {
        if (err || !val) {
          // Stale key, mark for removal
          oldKeysToRemove.push(keys[idx]);
          return;
        }
        const parsed = JSON.parse(val as string);
        const fileName = (parsed.file_name || 'unknown').toLowerCase().trim();
        const address = (parsed.address || 'unknown').toLowerCase().trim();
        const newKey = `result:${fileName}:${address}`;

        const existing = bestByKey.get(newKey);
        if (!existing || new Date(parsed.savedAt || 0).getTime() > new Date(existing.data.savedAt || 0).getTime()) {
          if (existing) oldKeysToRemove.push(existing.oldKey);
          bestByKey.set(newKey, { data: parsed, oldKey: keys[idx] });
        } else {
          oldKeysToRemove.push(keys[idx]);
        }
      });

      // Write deduplicated results with new deterministic keys
      const writePipeline = redis.pipeline();
      const newKeySet: string[] = [];

      for (const [newKey, { data, oldKey }] of bestByKey.entries()) {
        writePipeline.set(newKey, JSON.stringify(data));
        newKeySet.push(newKey);
        // If the old key is different from the new key, mark old for removal
        if (oldKey !== newKey) {
          oldKeysToRemove.push(oldKey);
        }
      }

      // Remove old keys
      if (oldKeysToRemove.length > 0) {
        const uniqueOldKeys = [...new Set(oldKeysToRemove)];
        uniqueOldKeys.forEach(k => writePipeline.del(k));
      }

      // Replace the result_keys set
      writePipeline.del("result_keys");
      if (newKeySet.length > 0) {
        writePipeline.sadd("result_keys", ...newKeySet);
      }

      await writePipeline.exec();

      return {
        message: "Cleanup complete",
        before: keys.length,
        after: newKeySet.length,
        removed: keys.length - newKeySet.length
      };
    } catch (err: any) {
      console.error("Cleanup error:", err.message);
      return { error: "Failed to clean up", details: err.message };
    }
  });

export default service;
