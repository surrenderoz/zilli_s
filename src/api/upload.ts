import { Elysia } from "elysia";
import fs from 'fs';
import csvParser from "csv-parser";
import { ParseCsv } from "../utils/parser";
import RunScrapper from "../utils/scrapper";
import { mkConfig, generateCsv, asString } from "export-to-csv";
import { writeFile } from "fs";
const csvConfig = mkConfig({ useKeysAsHeaders: true });

const service = new Elysia().post("/upload", async (context) => {
    //@ts-ignore
 const { file } = context.body;

 await Bun.write(`uploads/${file.name}`, file)
 function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

 const parsed_Data =  await ParseCsv(`uploads/${file.name}`)
// console.log(parsed_Data, "parsed_Data");
let next_ = false;
const scrapped_Val: Array<any> = [];
for(const values of parsed_Data) {
    if(values.email == "kristophergori@gmail.com") {
        next_ = true
    }
    if(!next_) {
        console.log(values.email);
        
        continue
    }
    
    const res = await RunScrapper(values.address)
    scrapped_Val.push({
        client_name: values.name,
        email: values.email,
        address: values.address,
        estimate: res
    })
    console.log(scrapped_Val, "scrapped data")
    const csv = generateCsv(csvConfig)(scrapped_Val);
    const filename = `${csvConfig.filename}.csv`;
    const csvBuffer = new Uint8Array(Buffer.from(asString(csv)));
    writeFile(filename, csvBuffer, (err) => {
      if (err) throw err;
      console.log("file saved: ", filename);
    });
    await delay(Math.floor(Math.random() * 20000) + 1)
}

  return {
    message: 'success',
    data: scrapped_Val
  };
});

export default service;
