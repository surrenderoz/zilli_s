import puppeteer from "puppeteer";
import csvParser from "csv-parser";
import fs from 'fs';
import { Elysia } from 'elysia'
import { swagger } from '@elysiajs/swagger'
import Service from "./api/upload";


const app = new Elysia();

app.use(Service)
app.get("/", () => "first api")
.use(swagger()) 
.listen(3006);

// ParseCsv()


// main()