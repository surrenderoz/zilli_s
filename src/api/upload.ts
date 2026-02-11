import { Elysia } from "elysia";
import { unlink, readFile, readdir, appendFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import pLimit from "p-limit";
import { ParseCsv } from "../utils/parser";
import { processAddress } from "./zen_row";
import { mkConfig, generateCsv, asString } from "export-to-csv";
import * as XLSX from 'xlsx';
import csvParser from 'csv-parser';

// Configs
const csvConfig = mkConfig({ useKeysAsHeaders: true, filename: 'processed_data' });
const appendConfig = mkConfig({ useKeysAsHeaders: false, filename: 'processed_data' }); // No header for append

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
                .on('data', (d) => processedRows.push(d))
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
            isStopped: false, // Default to false on restart
            isProcessing: false,
            clients: []
          });

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

      if (message.type === 'start') {
        if (upload.isProcessing) {
          console.log(`Session ${message.id}: Already processing.`);
          return;
        }

        console.log(`Session ${message.id}: Starting/Resuming...`);
        upload.isProcessing = true;
        upload.isStopped = false; // Reset stop flag on start/resume

        try {
          // RESUME LOGIC: Filter out already processed rows
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
                const res = await processAddress(values.address);

                const processedRow = {
                  client_name: values.name,
                  email: values.email,
                  address: values.address,
                  zillow_address: res?.zillow_address || "",
                  zillow_estimated_price: res?.zillow_estimated_price || "",
                  zipcode: res?.zipcode || "",
                  property_url: res?.property_url || "",
                  comment: res?.comment || ""
                };

                // Update Memory
                upload.processedRows.push(processedRow);

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
                  comment: `Processing Error: ${(e as any).message || e}`
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
        { header: 'Comment', key: 'comment', width: 30 }
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
      isProcessing: upload.isProcessing // Expose processing status
    };
  });

export default service;
